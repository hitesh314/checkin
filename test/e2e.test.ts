import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeGitleaks } from "./helpers/gitleaks.js";
import { createRepo, makeTempDir } from "./helpers/repo.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "checkin.js");
const built = existsSync(join(root, "dist", "cli.js"));

interface Seen {
  path: string;
  body: { model: string; messages: Array<{ role: string; content: string }>; options: { num_ctx: number } };
}

let server: Server;
let baseUrl: string;
const seen: Seen[] = [];
let nextReply = JSON.stringify({ subject: "feat(core): add greeting", body: "Adds a greeting file." });

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") {
        res.end(JSON.stringify({ models: [{ name: "mock-model:latest" }] }));
        return;
      }
      seen.push({ path: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.end(JSON.stringify({ done: true, done_reason: "stop", message: { role: "assistant", content: nextReply } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
});

function checkin(args: string[], cwd: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const configDir = makeTempDir("checkin-e2e-config-");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CHECKIN_SECRET_SCAN: "off", CHECKIN_CONFIG_DIR: configDir, CHECKIN_PROVIDER: "ollama", CHECKIN_MODEL: "mock-model", OLLAMA_HOST: baseUrl, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!built)("the built `checkin` binary (real process, real git, mock Ollama server)", () => {
  it("--help works and documents staging", async () => {
    const r = await checkin(["--help"], root);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("git add --all");
  });

  it("stages the whole repo from a subdirectory, sends the diff to the provider, and commits", async () => {
    const repo = createRepo();
    repo.write("top.txt", "hello from the top\n");
    repo.write("deep/er/inner.txt", "hello from inside\n");
    seen.length = 0;

    const r = await checkin([], join(repo.dir, "deep"));

    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Committed");
    expect(repo.messages()[0]).toBe("feat(core): add greeting\n\nAdds a greeting file.");
    expect(repo.git("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort()).toEqual(["deep/er/inner.txt", "top.txt"]);
    expect(repo.git("status", "--porcelain")).toBe("");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/api/chat");
    expect(seen[0]!.body.model).toBe("mock-model");
    const user = seen[0]!.body.messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("+hello from the top");
    expect(user).toContain("+hello from inside");
  });

  it("stops before contacting the provider when gitleaks reports a secret", async () => {
    const repo = createRepo();
    repo.write("config.ts", "const k = 'x';\n");
    seen.length = 0;
    const fake = fakeGitleaks({ exitCode: 2, report: [{ RuleID: "aws-access-token", File: "config.ts", StartLine: 1, Secret: "REDACTED" }] });

    const r = await checkin([], repo.dir, { CHECKIN_SECRET_SCAN: "auto", CHECKIN_GITLEAKS_PATH: fake.path });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("config.ts:1  (aws-access-token)");
    expect(seen).toHaveLength(0);
    expect(repo.log()).toHaveLength(1);
  });

  it.skipIf(!existsSync(join(root, "vendor", process.platform === "win32" ? "gitleaks.exe" : "gitleaks")))(
    "finds the gitleaks installed with checkin on its own and blocks a real secret before any request is made",
    async () => {
      const repo = createRepo();
      // Built at runtime so no token-shaped literal sits in the repository.
      const fakeToken = ["ghp", "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5"].join("_");
      repo.write("src/deploy.ts", `export const token = "${fakeToken}";\n`);
      seen.length = 0;

      const r = await checkin([], repo.dir, { CHECKIN_SECRET_SCAN: "required" });

      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Possible secret");
      expect(r.stderr).toContain("src/deploy.ts:1");
      expect(r.stderr).not.toContain(fakeToken);
      expect(seen).toHaveLength(0);
      expect(repo.log()).toHaveLength(1);

      repo.write("src/deploy.ts", "export const token = process.env.TOKEN;\n");
      const ok = await checkin([], repo.dir, { CHECKIN_SECRET_SCAN: "required" });
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain("Secret scan (gitleaks): no secrets found");
    },
  );

  it("--preview leaves changes staged and uncommitted", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");

    const r = await checkin(["--preview"], repo.dir);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("feat(core): add greeting");
    expect(r.stdout).toContain("Preview only");
    expect(repo.log()).toHaveLength(1);
    expect(repo.staged()).toEqual(["A a.txt"]);
  });

  it("--staged commits only the index", async () => {
    const repo = createRepo();
    repo.write("in.txt", "in\n");
    repo.git("add", "in.txt");
    repo.write("out.txt", "out\n");

    const r = await checkin(["--staged"], repo.dir);

    expect(r.code).toBe(0);
    expect(repo.git("show", "--name-only", "--format=", "HEAD").trim()).toBe("in.txt");
    expect(repo.git("status", "--porcelain").trim()).toBe("?? out.txt");
  });

  it("exits 0 without calling the provider when there is nothing to commit", async () => {
    const repo = createRepo();
    seen.length = 0;
    const r = await checkin([], repo.dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Nothing to commit");
    expect(seen).toHaveLength(0);
  });

  it("a rejecting hook yields exit 1, an explanation, and intact staged changes", async () => {
    const repo = createRepo();
    repo.hook("pre-commit", 'echo "hook says no" >&2; exit 1');
    repo.write("a.txt", "a\n");

    const r = await checkin([], repo.dir);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("hook says no");
    expect(r.stderr).toContain("never bypassed");
    expect(repo.log()).toHaveLength(1);
    expect(repo.staged()).toEqual(["A a.txt"]);
  });

  it("keeps shell metacharacters in a model-generated message literal", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    nextReply = JSON.stringify({ subject: "fix: handle `id` and $(touch pwned) ; echo \"x\"", body: "body $HOME && rm -rf /" });
    try {
      const r = await checkin([], repo.dir);
      expect(r.code).toBe(0);
    } finally {
      nextReply = JSON.stringify({ subject: "feat(core): add greeting", body: "Adds a greeting file." });
    }
    expect(repo.messages()[0]).toBe('fix: handle `id` and $(touch pwned) ; echo "x"\n\nbody $HOME && rm -rf /');
    expect(repo.exists("pwned")).toBe(false);
  });

  it("reports an unreachable provider cleanly (exit 1, no stack trace) and keeps changes staged", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");

    const r = await checkin([], repo.dir, { OLLAMA_HOST: "http://127.0.0.1:9", CHECKIN_TIMEOUT_MS: "2000" });

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/error: Could not reach Ollama/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(repo.staged()).toEqual(["A a.txt"]);
  }, 60_000);

  it("doctor checks the local provider", async () => {
    const repo = createRepo();
    repo.git("config", "user.name", "T");
    repo.git("config", "user.email", "t@example.com");
    const r = await checkin(["doctor"], repo.dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Ollama reachable");
  });

  it("rejects unknown options with usage exit code 2", async () => {
    const r = await checkin(["--nope"], root);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown option/);
  });
});

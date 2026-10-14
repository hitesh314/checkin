import { describe, expect, it } from "vitest";
import {
  createGitleaksScanner,
  describeFindings,
  parseFindings,
  resolveScanMode,
  usesGitSubcommand,
  type CommandRunner,
  type SecretScanner,
} from "../src/scan/gitleaks.js";
import { CheckinError } from "../src/util/errors.js";
import { runCheckin, type CheckinOptions } from "../src/workflow/checkin.js";
import { FakeProvider, makeContext } from "./helpers/fakes.js";
import { fakeGitleaks } from "./helpers/gitleaks.js";
import { createRepo } from "./helpers/repo.js";

const AUTO: CheckinOptions = { preview: false, staged: false };
const STAGED: CheckinOptions = { preview: false, staged: true };

const LEAK_REPORT = [
  { RuleID: "aws-access-token", File: "src/config.ts", StartLine: 12, Secret: "REDACTED", Match: "REDACTED" },
  { RuleID: "generic-api-key", File: "docs/a b.md", StartLine: 3 },
];

async function failure(promise: Promise<unknown>): Promise<CheckinError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(CheckinError);
    return e as CheckinError;
  }
  throw new Error("expected the run to fail");
}

describe("scan settings and parsing", () => {
  it("resolves CHECKIN_SECRET_SCAN", () => {
    expect(resolveScanMode({})).toBe("auto");
    expect(resolveScanMode({ CHECKIN_SECRET_SCAN: "" })).toBe("auto");
    expect(resolveScanMode({ CHECKIN_SECRET_SCAN: " Required " })).toBe("required");
    expect(resolveScanMode({ CHECKIN_SECRET_SCAN: "OFF" })).toBe("off");
    expect(() => resolveScanMode({ CHECKIN_SECRET_SCAN: "maybe" })).toThrow(/auto.*required.*off/);
  });

  it("picks the right gitleaks subcommand for the installed version", () => {
    expect(usesGitSubcommand("8.21.2")).toBe(true);
    expect(usesGitSubcommand("v8.19.0")).toBe(true);
    expect(usesGitSubcommand("9.0.0")).toBe(true);
    expect(usesGitSubcommand("8.18.4")).toBe(false);
    expect(usesGitSubcommand("v8.2.0")).toBe(false);
    expect(usesGitSubcommand("dev")).toBe(true);
  });

  it("reads only rule, file and line from a report and tolerates junk", () => {
    expect(parseFindings(JSON.stringify(LEAK_REPORT))).toEqual([
      { rule: "aws-access-token", file: "src/config.ts", line: 12 },
      { rule: "generic-api-key", file: "docs/a b.md", line: 3 },
    ]);
    expect(parseFindings("")).toEqual([]);
    expect(parseFindings("not json")).toBeNull();
    expect(parseFindings('{"a":1}')).toBeNull();
    expect(parseFindings("[null, 5]")).toEqual([
      { rule: "unknown-rule", file: "(unknown file)", line: undefined },
      { rule: "unknown-rule", file: "(unknown file)", line: undefined },
    ]);
  });

  it("lists at most ten findings", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ rule: "r", file: `f${i}`, line: i }));
    const text = describeFindings(many);
    expect(text).toContain("f9:9");
    expect(text).not.toContain("f10");
    expect(text).toContain("…and 3 more");
  });
});

describe("gitleaks adapter", () => {
  const scripted = (version: string, scan: { code: number; stdout?: string; stderr?: string } | null) => {
    const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const run: CommandRunner = async (command, args, o) => {
      calls.push({ command, args, cwd: o.cwd });
      if (args[0] === "version") return { code: 0, stdout: `${version}\n`, stderr: "" };
      return scan === null ? null : { code: scan.code, stdout: scan.stdout ?? "", stderr: scan.stderr ?? "" };
    };
    return { run, calls };
  };

  it("runs `gitleaks git --staged` with redaction and a dedicated leak exit code", async () => {
    const { run, calls } = scripted("8.21.2", { code: 0 });
    const result = await createGitleaksScanner({ run }).scanStaged("/repo");
    expect(result).toEqual({ status: "clean", version: "8.21.2" });
    const args = calls[1]!.args;
    expect(args.slice(0, 2)).toEqual(["git", "--staged"]);
    expect(args).toContain("--redact");
    expect(args.join(" ")).toContain("--exit-code 2");
    expect(args.join(" ")).toContain("--report-format json --report-path -");
    expect(calls[1]!.cwd).toBe("/repo");
  });

  it("uses `protect` for gitleaks older than 8.19", async () => {
    const { run, calls } = scripted("8.18.4", { code: 0 });
    await createGitleaksScanner({ run }).scanStaged("/repo");
    expect(calls[1]!.args[0]).toBe("protect");
  });

  it("reports findings (exit 2), and fails closed if the report is unreadable", async () => {
    const found = await createGitleaksScanner({ run: scripted("8.21.2", { code: 2, stdout: JSON.stringify(LEAK_REPORT) }).run }).scanStaged("/r");
    expect(found).toMatchObject({ status: "findings", findings: [{ rule: "aws-access-token" }, { rule: "generic-api-key" }] });
    const garbled = await createGitleaksScanner({ run: scripted("8.21.2", { code: 2, stdout: "???" }).run }).scanStaged("/r");
    expect(garbled).toEqual({ status: "findings", findings: [] });
  });

  it("treats other exit codes as a scanner error, with the last stderr line", async () => {
    const r = await createGitleaksScanner({ run: scripted("8.21.2", { code: 1, stderr: "boom\nfatal: bad config" }).run }).scanStaged("/r");
    expect(r).toMatchObject({ status: "error" });
    expect((r as { reason: string }).reason).toContain("exited with code 1: fatal: bad config");
  });

  it("reports a missing binary as unavailable, and a throwing runner as an error", async () => {
    const missing = await createGitleaksScanner({ run: async () => null }).scanStaged("/r");
    expect(missing).toMatchObject({ status: "unavailable" });
    const timedOut = await createGitleaksScanner({
      run: async (_c, args) => {
        if (args[0] === "version") return { code: 0, stdout: "8.21.2", stderr: "" };
        throw new Error("timed out after 60s");
      },
    }).scanStaged("/r");
    expect(timedOut).toMatchObject({ status: "error", reason: expect.stringContaining("timed out") });
  });

  it("really spawns a binary: clean, leaking, missing", async () => {
    const repo = createRepo();
    expect(await createGitleaksScanner({ command: fakeGitleaks().path }).scanStaged(repo.dir)).toMatchObject({ status: "clean" });
    const leaking = fakeGitleaks({ exitCode: 2, report: LEAK_REPORT });
    expect(await createGitleaksScanner({ command: leaking.path }).scanStaged(repo.dir)).toMatchObject({ status: "findings" });
    expect(leaking.scans()[0]!.slice(0, 2)).toEqual(["git", "--staged"]);
    expect(await createGitleaksScanner({ command: "/nonexistent/gitleaks" }).scanStaged(repo.dir)).toMatchObject({ status: "unavailable" });
  });
});

describe("secret scan in the workflow", () => {
  it("blocks before anything is sent or committed when secrets are found, listing file:line and rule only", async () => {
    const repo = createRepo();
    repo.write("src/config.ts", 'const key = "AKIAIOSFODNN7EXAMPLE";\n');
    const provider = new FakeProvider();
    const fake = fakeGitleaks({ exitCode: 2, report: LEAK_REPORT });
    const ctx = makeContext(repo, { provider, env: { CHECKIN_SECRET_SCAN: "auto", CHECKIN_GITLEAKS_PATH: fake.path } });
    const head = repo.head();

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toContain("Possible secrets found in the staged changes");
    expect(err.message).toContain("src/config.ts:12  (aws-access-token)");
    expect(err.message).toContain("docs/a b.md:3  (generic-api-key)");
    expect(err.message).not.toContain("AKIA");
    expect(err.hint).toContain("Nothing was sent to the AI provider");
    expect(err.hint).toContain("gitleaks:allow");
    expect(err.hint).toContain("Your changes are still staged"); // generic post-staging hint; nothing reset
    expect(provider.requests).toHaveLength(0);
    expect(ctx.fetchCalls).toHaveLength(0);
    expect(repo.head()).toBe(head);
  });

  it("also scans with --staged, and with --preview", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    repo.git("add", "a.txt");
    const fake = fakeGitleaks({ exitCode: 2, report: LEAK_REPORT });
    const ctx = makeContext(repo, { env: { CHECKIN_SECRET_SCAN: "auto", CHECKIN_GITLEAKS_PATH: fake.path } });
    await failure(runCheckin(STAGED, ctx.deps));
    await failure(runCheckin({ preview: true, staged: false }, ctx.deps));
    expect(fake.scans()).toHaveLength(2);
    expect(ctx.provider.requests).toHaveLength(0);
  });

  it("commits normally when the scan is clean, and says so", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const fake = fakeGitleaks();
    const ctx = makeContext(repo, { env: { CHECKIN_SECRET_SCAN: "auto", CHECKIN_GITLEAKS_PATH: fake.path } });

    expect(await runCheckin(AUTO, ctx.deps)).toBe("committed");

    expect(ctx.io.text()).toContain("Secret scan (gitleaks): no secrets found");
    expect(fake.scans()).toHaveLength(1);
  });

  it("does not scan when there is nothing to commit", async () => {
    const repo = createRepo();
    const fake = fakeGitleaks({ exitCode: 2, report: LEAK_REPORT });
    const ctx = makeContext(repo, { env: { CHECKIN_SECRET_SCAN: "auto", CHECKIN_GITLEAKS_PATH: fake.path } });
    expect(await runCheckin(AUTO, ctx.deps)).toBe("nothing");
    expect(fake.scans()).toHaveLength(0);
  });

  it("auto mode: warns loudly but continues when gitleaks is missing", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const ctx = makeContext(repo, { env: { CHECKIN_SECRET_SCAN: "auto", CHECKIN_GITLEAKS_PATH: "/nonexistent/gitleaks" } });

    expect(await runCheckin(AUTO, ctx.deps)).toBe("committed");

    expect(ctx.io.text()).toContain("NOT scanned for secrets");
    expect(ctx.io.text()).toContain("brew install gitleaks");
  });

  it("auto mode: a crashing scanner warns and continues", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const fake = fakeGitleaks({ exitCode: 1, stderr: "config error" });
    const ctx = makeContext(repo, { env: { CHECKIN_SECRET_SCAN: "auto", CHECKIN_GITLEAKS_PATH: fake.path } });
    expect(await runCheckin(AUTO, ctx.deps)).toBe("committed");
    expect(ctx.io.text()).toContain("the secret scan failed");
    expect(ctx.io.text()).toContain("exited with code 1");
  });

  it("required mode: refuses when gitleaks is missing or crashes, before sending anything", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const missing = makeContext(repo, { env: { CHECKIN_SECRET_SCAN: "required", CHECKIN_GITLEAKS_PATH: "/nonexistent/gitleaks" } });
    const e1 = await failure(runCheckin(AUTO, missing.deps));
    expect(e1.message).toContain("CHECKIN_SECRET_SCAN=required");
    expect(missing.provider.requests).toHaveLength(0);

    const crashing = makeContext(repo, { env: { CHECKIN_SECRET_SCAN: "required", CHECKIN_GITLEAKS_PATH: fakeGitleaks({ exitCode: 1 }).path } });
    await failure(runCheckin(AUTO, crashing.deps));
    expect(crashing.provider.requests).toHaveLength(0);
    expect(repo.log()).toHaveLength(1);
  });

  it("off mode never runs the scanner", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const fake = fakeGitleaks({ exitCode: 2, report: LEAK_REPORT });
    const ctx = makeContext(repo, { env: { CHECKIN_SECRET_SCAN: "off", CHECKIN_GITLEAKS_PATH: fake.path } });
    expect(await runCheckin(AUTO, ctx.deps)).toBe("committed");
    expect(fake.scans()).toHaveLength(0);
  });

  it("rejects an invalid CHECKIN_SECRET_SCAN before staging anything", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const ctx = makeContext(repo, { env: { CHECKIN_SECRET_SCAN: "sometimes" } });
    await failure(runCheckin(AUTO, ctx.deps));
    expect(repo.git("diff", "--cached", "--name-only")).toBe("");
  });

  it("uses an injected scanner and runs the env-file guard first", async () => {
    const repo = createRepo();
    repo.write(".env", "A=1\n");
    repo.git("add", ".env");
    let scanned = 0;
    const scanner: SecretScanner = {
      async scanStaged() {
        scanned++;
        return { status: "clean", version: "x" };
      },
    };
    const ctx = makeContext(repo, { env: { CHECKIN_SECRET_SCAN: "auto" } });
    ctx.deps.secretScanner = scanner;
    const err = await failure(runCheckin(STAGED, ctx.deps));
    expect(err.message).toContain("Environment file(s) are staged");
    expect(scanned).toBe(0);
  });
});

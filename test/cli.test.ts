import { describe, expect, it } from "vitest";
import { run, type CliDeps } from "../src/cli.js";
import { createMemoryStore } from "../src/credentials/store.js";
import { createBufferIo } from "../src/util/io.js";
import { fakeGitleaks } from "./helpers/gitleaks.js";
import { FakeProvider, jsonResponse, mockFetch, reply } from "./helpers/fakes.js";
import { createRepo, makeTempDir, type TestRepo } from "./helpers/repo.js";

function cli(repo: TestRepo | null, overrides: Partial<CliDeps> = {}) {
  const io = createBufferIo();
  const dir = makeTempDir("checkin-cli-");
  const provider = new FakeProvider(reply("feat: add things"));
  const deps: CliDeps = {
    cwd: repo?.dir ?? dir,
    env: { CHECKIN_SECRET_SCAN: "off", CHECKIN_PROVIDER: "openai", OPENAI_API_KEY: "sk-cli-0123456789abcdef0123", CHECKIN_CONFIG_DIR: dir },
    io,
    fetch: mockFetch(jsonResponse({ id: "ok" })).fetch,
    sleep: async () => {},
    secrets: createMemoryStore(),
    configLocation: { dir, file: `${dir}/config.json` },
    prompter: () => {
      throw new Error("prompter should not be created");
    },
    interactive: false,
    inheritCommitStdio: false,
    providerFactory: () => provider,
    ...overrides,
  };
  return { deps, io, provider };
}

describe("help and version", () => {
  it("--help explains staging behaviour and exits 0", async () => {
    const { deps, io } = cli(null);
    expect(await run(["--help"], deps)).toBe(0);
    const text = io.text();
    expect(text).toContain("Usage: checkin");
    expect(text).toContain("git add --all");
    expect(text).toContain("repository root");
    expect(text).toMatch(/--staged.*never runs `git add`/s);
    expect(text).toMatch(/--preview.*has still\s+staged everything/s);
    expect(text).toContain("--preview --staged");
    expect(text).toContain("never");
    for (const word of ["setup", "doctor", "--ticket", "--preview", "--staged"]) expect(text).toContain(word);
  });

  it("-h is the same as --help", async () => {
    const { deps, io } = cli(null);
    expect(await run(["-h"], deps)).toBe(0);
    expect(io.text()).toContain("How staging works");
  });

  it("--version prints the package version", async () => {
    const { deps, io } = cli(null);
    expect(await run(["--version"], deps)).toBe(0);
    expect(io.text()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("argument handling", () => {
  it("rejects unknown options with exit code 2 and does not touch the repository", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const { deps, io } = cli(repo);
    expect(await run(["--yolo"], deps)).toBe(2);
    expect(io.text()).toMatch(/unknown option/);
    expect(repo.staged()).toEqual([]);
  });

  it("rejects unknown commands and stray arguments with exit code 2", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const { deps } = cli(repo);
    expect(await run(["frobnicate"], deps)).toBe(2);
    expect(repo.staged()).toEqual([]);
  });

  it("--ticket requires a value", async () => {
    const { deps, io } = cli(null);
    expect(await run(["--ticket"], deps)).toBe(2);
    expect(io.text()).toMatch(/argument missing/);
  });

  it("rejects a malformed ticket before staging anything", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const { deps, io } = cli(repo);
    expect(await run(["--ticket", "banana"], deps)).toBe(1);
    expect(io.text()).toContain("not a valid Jira ticket key");
    expect(repo.staged()).toEqual([]);
  });

  it.each([["--preview"], ["--staged"], ["--ticket", "PROJ-1"]])("refuses workflow flags (%s) on setup and doctor", async (...flags) => {
    for (const command of ["setup", "doctor"]) {
      const { deps, io } = cli(null, { interactive: true });
      expect(await run([command, ...flags], deps)).toBe(1);
      expect(io.text()).toMatch(/cannot be used with/);
    }
  });

  it("setup refuses to run without a terminal", async () => {
    const { deps, io } = cli(null, { interactive: false });
    expect(await run(["setup"], deps)).toBe(1);
    expect(io.text()).toMatch(/needs a terminal/);
  });
});

describe("default command through the CLI", () => {
  it("stages, generates and commits (exit 0)", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const { deps, io } = cli(repo);
    expect(await run([], deps)).toBe(0);
    expect(repo.messages()[0]).toBe("feat: add things");
    expect(io.text()).toContain("Committed");
  });

  it("--preview --staged commits nothing", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    repo.git("add", "a.txt");
    const { deps, io } = cli(repo);
    expect(await run(["--preview", "--staged"], deps)).toBe(0);
    expect(repo.log()).toHaveLength(1);
    expect(io.text()).toContain("feat: add things");
  });

  it("exits 0 with a message when there is nothing to commit", async () => {
    const repo = createRepo();
    const { deps, io, provider } = cli(repo);
    expect(await run([], deps)).toBe(0);
    expect(provider.requests).toHaveLength(0);
    expect(io.text()).toContain("Nothing to commit");
  });

  it("renders failures as `error:` plus an actionable hint with exit code 1", async () => {
    const repo = createRepo();
    repo.git("checkout", "-q", "--detach");
    const { deps, io } = cli(repo);
    expect(await run([], deps)).toBe(1);
    expect(io.stderr[0]).toMatch(/^error: HEAD is detached/);
    expect(io.stderr[1]).toContain("git switch -c");
  });

  it("renders an unexpected exception without a stack trace and with secrets removed", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const { deps, io } = cli(repo, {
      providerFactory: () => {
        throw new Error("kaboom with sk-leaky-0123456789abcdefghij inside");
      },
    });
    expect(await run([], deps)).toBe(1);
    expect(io.text()).toContain("unexpected failure: kaboom");
    expect(io.text()).not.toContain("sk-leaky");
    expect(io.text()).not.toContain("    at ");
  });
});

describe("doctor", () => {
  it("passes (exit 0) for a healthy setup", async () => {
    const repo = createRepo();
    repo.git("config", "user.name", "T");
    repo.git("config", "user.email", "t@example.com");
    const { deps, io } = cli(repo, { env: { CHECKIN_PROVIDER: "openai", OPENAI_API_KEY: "sk-cli-0123456789abcdef0123", CHECKIN_GITLEAKS_PATH: fakeGitleaks().path } });
    expect(await run(["doctor"], deps)).toBe(0);
    const text = io.text();
    expect(text).toContain("Secret scanning: gitleaks 8.21.2 (from CHECKIN_GITLEAKS_PATH; mode: auto)");
    expect(text).toContain("All checks passed");
    expect(text).toContain("Provider OpenAI");
    expect(text).toContain("reachable");
  });

  it("fails (exit 1) and says what to do when nothing is configured", async () => {
    const dir = makeTempDir();
    const { deps, io } = cli(null, { env: { CHECKIN_CONFIG_DIR: dir } });
    expect(await run(["doctor"], deps)).toBe(1);
    expect(io.text()).toMatch(/AI provider\s+not configured — run `checkin setup`/);
    expect(io.text()).toContain("problem");
  });

  it("flags a missing key and a rejected key distinctly", async () => {
    const noKey = cli(null, { env: { CHECKIN_PROVIDER: "openai" } });
    expect(await run(["doctor"], noKey.deps)).toBe(1);
    expect(noKey.io.text()).toMatch(/API key\s+not found/);

    const badKey = cli(null, { fetch: mockFetch(jsonResponse({ error: { message: "Incorrect API key" } }, 401)).fetch });
    expect(await run(["doctor"], badKey.deps)).toBe(1);
    expect(badKey.io.text()).toContain("rejected the credentials");
    expect(badKey.io.text()).not.toContain("sk-cli-0123456789");
  });

  it("warns, rather than fails, when the credential store is unavailable but env vars work", async () => {
    const { deps, io } = cli(null, { secrets: createMemoryStore({}, false) });
    expect(await run(["doctor"], deps)).toBe(0);
    expect(io.text()).toMatch(/! Credential store unavailable/);
  });

  it("diagnoses Jira connectivity when configured", async () => {
    const jiraEnv = { CHECKIN_JIRA_SITE_URL: "https://a.atlassian.net", CHECKIN_JIRA_EMAIL: "a@b.c", CHECKIN_JIRA_API_TOKEN: "tok-0123456789" };
    const ok = cli(null);
    ok.deps.env = { ...ok.deps.env, ...jiraEnv };
    ok.deps.fetch = mockFetch(jsonResponse({ id: "ok", displayName: "Dev" })).fetch;
    expect(await run(["doctor"], ok.deps)).toBe(0);
    expect(ok.io.text()).toContain("Jira reachable; credentials accepted");

    const bad = cli(null);
    bad.deps.env = { ...bad.deps.env, ...jiraEnv };
    bad.deps.fetch = mockFetch((call) => (call.url.includes("jira") || call.url.includes("atlassian") ? jsonResponse({}, 401) : jsonResponse({ id: "ok" }))).fetch;
    expect(await run(["doctor"], bad.deps)).toBe(1);
    expect(bad.io.text()).toContain("Jira connectivity");
    expect(bad.io.text()).not.toContain("tok-0123456789");
  });

  it("works outside a repository", async () => {
    const { deps, io } = cli(null);
    expect(await run(["doctor"], deps)).toBe(0);
    expect(io.text()).toContain("Not inside a Git repository");
  });

  it("reports an unset git identity as a problem, since commits would fail", async () => {
    const repo = createRepo();
    const env = { ...process.env };
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_COMMITTER_NAME;
    try {
      const { deps, io } = cli(repo);
      // `git config user.name` reads config only (env vars don't count), so with isolated global config it is unset.
      expect(await run(["doctor"], deps)).toBe(1);
      expect(io.text()).toContain("Git identity is not set");
    } finally {
      process.env.GIT_AUTHOR_NAME = env.GIT_AUTHOR_NAME;
      process.env.GIT_COMMITTER_NAME = env.GIT_COMMITTER_NAME;
    }
  });
});

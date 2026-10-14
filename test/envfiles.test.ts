import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isEnvironmentFile } from "../src/git/envfiles.js";
import { CheckinError } from "../src/util/errors.js";
import { runCheckin, type CheckinOptions } from "../src/workflow/checkin.js";
import { FakeProvider, makeContext } from "./helpers/fakes.js";
import { createRepo } from "./helpers/repo.js";

const AUTO: CheckinOptions = { preview: false, staged: false };
const STAGED: CheckinOptions = { preview: false, staged: true };

describe("isEnvironmentFile", () => {
  it.each([
    ".env",
    ".env.local",
    ".env.production",
    ".ENV",
    "api/.env",
    "a/b/c/.env.development.local",
    "prod.env",
    "config/staging.env",
    ".envrc",
    ".env/lib/site.py",
    "pkg/.env/bin/activate",
  ])("flags %s", (p) => expect(isEnvironmentFile(p)).toBe(true));

  it.each([
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.dist",
    "api/.env.example",
    "environment.ts",
    "src/env.ts",
    "src/.environment",
    "env",
    "dotenv.js",
    ".envoy.yaml",
    "README.md",
    "src/app.txt",
    ".env-notes.md",
  ])("allows %s", (p) => expect(isEnvironmentFile(p)).toBe(false));
});

async function failure(promise: Promise<unknown>): Promise<CheckinError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(CheckinError);
    return e as CheckinError;
  }
  throw new Error("expected the run to fail");
}

describe("environment files and automatic staging", () => {
  it("never stages or commits untracked env files (root, nested, variants), and says which were skipped", async () => {
    const repo = createRepo();
    repo.write(".env", "API_KEY=super-secret\n");
    repo.write(".env.local", "X=1\n");
    repo.write("api/.env.production", "Y=2\n");
    repo.write("prod.env", "Z=3\n");
    repo.write("py/.env/lib/x.py", "print()\n");
    repo.write("feature.txt", "real change\n");
    const provider = new FakeProvider();
    const ctx = makeContext(repo, { provider });

    expect(await runCheckin(AUTO, ctx.deps)).toBe("committed");

    expect(repo.git("show", "--name-only", "--format=", "HEAD").trim()).toBe("feature.txt");
    const left = repo.git("status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).sort();
    expect(left).toEqual(["?? .env", "?? .env.local", "?? api/.env.production", "?? prod.env", "?? py/.env/lib/x.py"]);
    expect(repo.read(".env")).toBe("API_KEY=super-secret\n"); // file untouched
    expect(ctx.io.text()).toContain("Skipped 5 environment files (left unstaged)");
    expect(ctx.io.text()).toContain(".env.local");
    // The secret never reached the provider.
    expect(JSON.stringify(provider.requests)).not.toContain("super-secret");
  });

  it("leaves a modified, already-tracked env file unstaged and unsent", async () => {
    const repo = createRepo();
    repo.write(".env", "TOKEN=old\n");
    repo.commitAll("chore: track env (oops)");
    repo.write(".env", "TOKEN=new-secret-value\n");
    repo.write("a.txt", "a\n");
    const provider = new FakeProvider();
    const ctx = makeContext(repo, { provider });

    await runCheckin(AUTO, ctx.deps);

    expect(repo.git("show", "--name-only", "--format=", "HEAD").trim()).toBe("a.txt");
    expect(repo.git("status", "--porcelain")).toBe(" M .env\n");
    expect(JSON.stringify(provider.requests)).not.toContain("new-secret-value");
  });

  it("does not stage the deletion of a tracked env file either", async () => {
    const repo = createRepo();
    repo.write(".env", "TOKEN=old\n");
    repo.commitAll("chore: track env");
    repo.remove(".env");
    repo.write("a.txt", "a\n");
    const ctx = makeContext(repo);

    await runCheckin(AUTO, ctx.deps);

    expect(repo.git("show", "--name-status", "--format=", "HEAD").trim()).toBe("A\ta.txt");
    expect(repo.git("status", "--porcelain")).toBe(" D .env\n");
  });

  it("still commits template files like .env.example", async () => {
    const repo = createRepo();
    repo.write(".env.example", "API_KEY=\n");
    repo.write("api/.env.sample", "X=\n");
    repo.write(".env", "API_KEY=real\n");
    const ctx = makeContext(repo);

    await runCheckin(AUTO, ctx.deps);

    expect(repo.git("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort()).toEqual([".env.example", "api/.env.sample"]);
    expect(repo.git("status", "--porcelain")).toBe("?? .env\n");
  });

  it("with only env files changed it reports nothing to commit, calls no AI, and leaves them alone", async () => {
    const repo = createRepo();
    repo.write(".env", "A=1\n");
    const provider = new FakeProvider();
    const ctx = makeContext(repo, { provider });
    const head = repo.head();

    expect(await runCheckin(AUTO, ctx.deps)).toBe("nothing");

    expect(provider.requests).toHaveLength(0);
    expect(repo.head()).toBe(head);
    expect(repo.git("diff", "--cached", "--name-only")).toBe("");
    expect(ctx.io.text()).toContain("Nothing to commit");
    expect(ctx.io.text()).toContain("Skipped 1 environment file (left unstaged): .env");
  });

  it("works from a subdirectory and in a repository with no commits yet", async () => {
    const repo = createRepo({ commit: false });
    repo.write(".env", "A=1\n");
    repo.write("src/.env.local", "B=2\n");
    repo.write("src/main.txt", "hi\n");
    const ctx = makeContext(repo, { cwd: join(repo.dir, "src") });

    expect(await runCheckin(AUTO, ctx.deps)).toBe("committed");

    expect(repo.git("show", "--name-only", "--format=", "HEAD").trim()).toBe("src/main.txt");
  });

  it("--preview does not stage env files either", async () => {
    const repo = createRepo();
    repo.write(".env", "A=1\n");
    repo.write("a.txt", "a\n");
    const ctx = makeContext(repo);

    await runCheckin({ preview: true, staged: false }, ctx.deps);

    expect(repo.staged().join("\n")).toContain("a.txt");
    expect(repo.staged().join("\n")).not.toContain(".env");
  });

  it("stages files with glob characters, spaces, and a leading dash literally (alongside skipped env files)", async () => {
    const repo = createRepo();
    repo.write(".env", "A=1\n");
    repo.write("[x].txt", "1\n");
    repo.write("a b*.txt", "2\n");
    repo.write("-dash.txt", "3\n");
    repo.write("ünï.txt", "4\n");
    repo.write("other.txt", "5\n");
    const ctx = makeContext(repo);

    await runCheckin(AUTO, ctx.deps);

    expect(repo.git("-c", "core.quotepath=off", "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort()).toEqual(
      ["-dash.txt", "[x].txt", "a b*.txt", "other.txt", "ünï.txt"].sort(),
    );
    expect(repo.git("status", "--porcelain")).toBe("?? .env\n");
  });

  it("handles staged renames of other files while skipping env files", async () => {
    const repo = createRepo();
    repo.git("mv", "src/app.txt", "src/renamed.txt");
    repo.write(".env", "A=1\n");
    const ctx = makeContext(repo);

    await runCheckin(AUTO, ctx.deps);

    expect(repo.git("show", "--name-status", "--format=", "HEAD").trim()).toMatch(/^R\d+\tsrc\/app\.txt\tsrc\/renamed\.txt$/);
    expect(repo.git("status", "--porcelain")).toBe("?? .env\n");
  });
});

describe("environment files that are already staged", () => {
  it("refuses before contacting the provider or committing, and does not unstage anything", async () => {
    const repo = createRepo();
    repo.write(".env", "API_KEY=super-secret\n");
    repo.git("add", ".env");
    repo.write("a.txt", "a\n");
    const provider = new FakeProvider();
    const ctx = makeContext(repo, { provider });
    const head = repo.head();

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toContain("Environment file(s) are staged: .env");
    expect(err.hint).toContain("git restore --staged");
    expect(err.hint).toContain("Nothing was sent");
    expect(provider.requests).toHaveLength(0);
    expect(repo.head()).toBe(head);
    expect(repo.staged().join("\n")).toContain(".env");
    expect(repo.staged().join("\n")).toContain("a.txt"); // default mode did stage the rest; nothing was reset
  });

  it("also refuses with --staged", async () => {
    const repo = createRepo();
    repo.write("config/.env.local", "S=1\n");
    repo.write("a.txt", "a\n");
    repo.git("add", "--all");
    const provider = new FakeProvider();
    const ctx = makeContext(repo, { provider });

    const err = await failure(runCheckin(STAGED, ctx.deps));

    expect(err.message).toContain("config/.env.local");
    expect(provider.requests).toHaveLength(0);
    expect(repo.log()).toHaveLength(1);
  });

  it("refuses when a tracked env file's deletion or rename is staged (its contents would appear in the diff)", async () => {
    const repo = createRepo();
    repo.write(".env", "TOKEN=abc\n");
    repo.commitAll("chore: oops");
    repo.git("mv", ".env", "settings.txt");
    const provider = new FakeProvider();
    const ctx = makeContext(repo, { provider });

    const err = await failure(runCheckin(STAGED, ctx.deps));

    expect(err.message).toContain(".env");
    expect(provider.requests).toHaveLength(0);
  });

  it("--staged still allows a staged .env.example", async () => {
    const repo = createRepo();
    repo.write(".env.example", "KEY=\n");
    repo.git("add", ".env.example");
    const ctx = makeContext(repo);

    expect(await runCheckin(STAGED, ctx.deps)).toBe("committed");
  });
});

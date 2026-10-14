import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CheckinError } from "../src/util/errors.js";
import { runCheckin, type CheckinOptions } from "../src/workflow/checkin.js";
import { FakeProvider, makeContext, reply } from "./helpers/fakes.js";
import { createRepo, makeTempDir } from "./helpers/repo.js";

const AUTO: CheckinOptions = { preview: false, staged: false };

async function failure(promise: Promise<unknown>): Promise<CheckinError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(CheckinError);
    return e as CheckinError;
  }
  throw new Error("expected the run to fail");
}

describe("automatic staging and commit", () => {
  it("stages new, modified and deleted files and commits them with the generated message", async () => {
    const repo = createRepo();
    repo.write("README.md", "# demo\nmore\n"); // modified
    repo.write("docs/new.md", "new file\n"); // added (untracked, in a new directory)
    repo.remove("src/app.txt"); // deleted
    const ctx = makeContext(repo, { provider: new FakeProvider(reply("feat(docs): add a new page", "Adds docs/new.md.")) });

    const outcome = await runCheckin(AUTO, ctx.deps);

    expect(outcome).toBe("committed");
    expect(repo.messages()[0]).toBe("feat(docs): add a new page\n\nAdds docs/new.md.");
    expect(repo.git("show", "--name-status", "--format=", "HEAD").split("\n").filter(Boolean).sort()).toEqual([
      "A\tdocs/new.md",
      "D\tsrc/app.txt",
      "M\tREADME.md",
    ]);
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(ctx.io.text()).toContain("Committed");
    expect(ctx.io.text()).toContain("Staged all changes");
  });

  it("works from a subdirectory and still stages the whole repository", async () => {
    const repo = createRepo();
    repo.write("top-level.txt", "x\n");
    repo.write("src/deep/inner.txt", "y\n");
    const ctx = makeContext(repo, { cwd: join(repo.dir, "src", "deep") });

    await runCheckin(AUTO, ctx.deps);

    const files = repo.git("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort();
    expect(files).toEqual(["src/deep/inner.txt", "top-level.txt"]);
  });

  it("respects .gitignore and never commits ignored files", async () => {
    const repo = createRepo();
    repo.write(".gitignore", "*.log\nbuild/\n");
    repo.write("debug.log", "noise\n");
    repo.write("build/out.js", "compiled\n");
    repo.write("keep.txt", "keep\n");
    const ctx = makeContext(repo);

    await runCheckin(AUTO, ctx.deps);

    const files = repo.git("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort();
    expect(files).toEqual([".gitignore", "keep.txt"]);
    expect(ctx.provider.requests[0]!.user).not.toContain("debug.log");
    expect(ctx.provider.requests[0]!.user).not.toContain("compiled");
  });

  it("includes previously staged changes together with unstaged ones", async () => {
    const repo = createRepo();
    repo.write("staged.txt", "s\n");
    repo.git("add", "staged.txt");
    repo.write("unstaged.txt", "u\n");
    const ctx = makeContext(repo);

    await runCheckin(AUTO, ctx.deps);

    const files = repo.git("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort();
    expect(files).toEqual(["staged.txt", "unstaged.txt"]);
  });

  it("makes the first commit in a repository with no initial commit", async () => {
    const repo = createRepo({ commit: false });
    repo.write("a.txt", "a\n");
    const ctx = makeContext(repo);

    expect(repo.head()).toBeNull();
    await runCheckin(AUTO, ctx.deps);

    expect(repo.head()).not.toBeNull();
    expect(repo.log()).toHaveLength(1);
    expect(repo.git("show", "--name-only", "--format=", "HEAD").trim()).toBe("a.txt");
  });
});

describe("nothing to commit", () => {
  it("exits successfully without calling the AI when the tree is clean", async () => {
    const repo = createRepo();
    const ctx = makeContext(repo);

    expect(await runCheckin(AUTO, ctx.deps)).toBe("nothing");

    expect(ctx.provider.requests).toHaveLength(0);
    expect(repo.log()).toHaveLength(1);
    expect(ctx.io.text()).toContain("Nothing to commit");
    expect(ctx.io.text()).not.toContain("Staged all changes"); // nothing was staged, so don't claim it
  });

  it("handles an empty repository with no commits and no files", async () => {
    const repo = createRepo({ commit: false });
    const ctx = makeContext(repo);

    expect(await runCheckin(AUTO, ctx.deps)).toBe("nothing");

    expect(ctx.provider.requests).toHaveLength(0);
    expect(repo.head()).toBeNull();
  });

  it("treats a tree with only ignored files as clean", async () => {
    const repo = createRepo();
    repo.write(".gitignore", "*.tmp\n");
    repo.commitAll("chore: ignore tmp");
    repo.write("scratch.tmp", "x\n");
    const ctx = makeContext(repo);

    expect(await runCheckin(AUTO, ctx.deps)).toBe("nothing");
    expect(ctx.provider.requests).toHaveLength(0);
  });
});

describe("--preview and --staged", () => {
  it("--preview stages and generates but does not commit, and says that it staged", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    repo.write("src/app.txt", "changed\n");
    const before = repo.head();
    const ctx = makeContext(repo);

    expect(await runCheckin({ preview: true, staged: false }, ctx.deps)).toBe("previewed");

    expect(repo.head()).toBe(before);
    expect(repo.staged().sort()).toEqual(["A a.txt", "M src/app.txt"]);
    const text = ctx.io.text();
    expect(text).toContain("feat: add the thing");
    expect(text).toContain("preview stages your changes");
    expect(text).toContain("git restore --staged .");
  });

  it("--preview suggests the right undo command when there is no commit yet", async () => {
    const repo = createRepo({ commit: false });
    repo.write("a.txt", "a\n");
    const ctx = makeContext(repo);

    await runCheckin({ preview: true, staged: false }, ctx.deps);

    expect(ctx.io.text()).toContain("git rm -r --cached .");
  });

  it("--staged commits only what is already staged and leaves other changes alone", async () => {
    const repo = createRepo();
    repo.write("staged.txt", "s\n");
    repo.git("add", "staged.txt");
    repo.write("src/app.txt", "modified but unstaged\n");
    repo.write("untracked.txt", "u\n");
    const ctx = makeContext(repo);

    expect(await runCheckin({ preview: false, staged: true }, ctx.deps)).toBe("committed");

    expect(repo.git("show", "--name-only", "--format=", "HEAD").trim()).toBe("staged.txt");
    expect(repo.git("status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([" M src/app.txt", "?? untracked.txt"]);
    expect(ctx.provider.requests[0]!.user).not.toContain("modified but unstaged");
  });

  it("--staged with nothing staged exits successfully without calling the AI or staging anything", async () => {
    const repo = createRepo();
    repo.write("untracked.txt", "u\n");
    const ctx = makeContext(repo);

    expect(await runCheckin({ preview: false, staged: true }, ctx.deps)).toBe("nothing");

    expect(ctx.provider.requests).toHaveLength(0);
    expect(repo.staged()).toEqual([]);
    expect(repo.git("status", "--porcelain").trim()).toBe("?? untracked.txt");
  });

  it("--preview --staged generates for the current index and changes nothing", async () => {
    const repo = createRepo();
    repo.write("staged.txt", "s\n");
    repo.git("add", "staged.txt");
    repo.write("other.txt", "o\n");
    const before = repo.head();
    const indexBefore = repo.git("write-tree");
    const ctx = makeContext(repo);

    expect(await runCheckin({ preview: true, staged: true }, ctx.deps)).toBe("previewed");

    expect(repo.head()).toBe(before);
    expect(repo.git("write-tree")).toBe(indexBefore);
    expect(repo.git("status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual(["?? other.txt", "A  staged.txt"]);
    expect(ctx.io.text()).not.toContain("preview stages your changes");
    expect(ctx.provider.requests).toHaveLength(1);
  });
});

describe("repository state guards", () => {
  it("rejects unresolved merge conflicts and does not stage (or 'resolve') anything", async () => {
    const repo = createRepo();
    repo.git("switch", "-q", "-c", "other");
    repo.write("src/app.txt", "other side\n");
    repo.commitAll("other change");
    repo.git("switch", "-q", "main");
    repo.write("src/app.txt", "main side\n");
    repo.commitAll("main change");
    expect(() => repo.git("merge", "other")).toThrow();
    repo.write("unrelated.txt", "u\n");
    const ctx = makeContext(repo);

    const err = await failure(runCheckin(AUTO, ctx.deps));

    // MERGE_HEAD exists, so the in-progress guard fires first and explains the situation.
    expect(err.message).toMatch(/merge is in progress/);
    expect(repo.git("ls-files", "-u")).toContain("src/app.txt"); // still conflicted
    expect(repo.git("status", "--porcelain")).toContain("?? unrelated.txt"); // git add --all never ran
    expect(ctx.provider.requests).toHaveLength(0);
  });

  it("rejects unresolved conflicts even when no operation marker is present", async () => {
    const repo = createRepo();
    repo.git("switch", "-q", "-c", "other");
    repo.write("src/app.txt", "other side\n");
    repo.commitAll("other change");
    repo.git("switch", "-q", "main");
    repo.write("src/app.txt", "main side\n");
    repo.commitAll("main change");
    expect(() => repo.git("merge", "other")).toThrow();
    repo.remove(".git/MERGE_HEAD");
    const ctx = makeContext(repo);

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toMatch(/Unresolved merge conflicts in 1 file/);
    expect(err.message).toContain("src/app.txt");
    expect(repo.git("ls-files", "-u")).toContain("src/app.txt");
    expect(ctx.provider.requests).toHaveLength(0);
  });

  it.each([
    ["rebase-merge", "dir"],
    ["rebase-apply", "dir"],
    ["CHERRY_PICK_HEAD", "file"],
    ["REVERT_HEAD", "file"],
    ["BISECT_LOG", "file"],
  ])("rejects an in-progress operation (%s)", async (marker, kind) => {
    const repo = createRepo();
    repo.write("pending.txt", "p\n");
    if (kind === "dir") repo.write(`.git/${marker}/placeholder`, "");
    else repo.write(`.git/${marker}`, repo.head() + "\n");
    const ctx = makeContext(repo);

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toMatch(/in progress/);
    expect(repo.staged()).toEqual([]);
    expect(ctx.provider.requests).toHaveLength(0);
  });

  it("rejects a real in-progress rebase", async () => {
    const repo = createRepo();
    repo.git("switch", "-q", "-c", "topic");
    repo.write("src/app.txt", "topic\n");
    repo.commitAll("topic change");
    repo.git("switch", "-q", "main");
    repo.write("src/app.txt", "main\n");
    repo.commitAll("main change");
    repo.git("switch", "-q", "topic");
    expect(() => repo.git("rebase", "main")).toThrow();
    const ctx = makeContext(repo);

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toMatch(/rebase/);
    expect(ctx.provider.requests).toHaveLength(0);
  });

  it("gives an actionable error on a detached HEAD", async () => {
    const repo = createRepo();
    repo.git("checkout", "-q", "--detach");
    repo.write("a.txt", "a\n");
    const ctx = makeContext(repo);

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toMatch(/detached/);
    expect(err.hint).toContain("git switch -c");
    expect(repo.staged()).toEqual([]);
    expect(ctx.provider.requests).toHaveLength(0);
  });

  it("fails clearly outside a repository", async () => {
    const repo = createRepo();
    const ctx = makeContext(repo, { cwd: makeTempDir("not-a-repo-") });

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toMatch(/Not inside a Git working tree/);
  });

  it("does not stage anything when configuration is missing", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const ctx = makeContext(repo, { env: { CHECKIN_PROVIDER: "", OPENAI_API_KEY: "" } });
    delete ctx.deps.env.CHECKIN_PROVIDER;

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toMatch(/No AI provider is configured/);
    expect(repo.staged()).toEqual([]);
  });
});

describe("repository changes during generation", () => {
  it("aborts when HEAD moves (another commit lands) and leaves everything as it is", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const provider = new FakeProvider(() => {
      // Another process advances the branch without touching our index.
      const head = repo.head()!;
      const commit = repo.git("commit-tree", `${head}^{tree}`, "-p", head, "-m", "someone else committed").trim();
      repo.git("update-ref", "refs/heads/main", commit);
      return reply("feat: add a");
    });
    const ctx = makeContext(repo, { provider });
    const headBefore = repo.head();

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toMatch(/changed while the message was being generated/);
    expect(err.message).toMatch(/HEAD moved/);
    expect(repo.log()).toHaveLength(2); // initial + the other process's commit; ours was not made
    expect(repo.head()).not.toBe(headBefore);
    expect(repo.staged()).toEqual(["A a.txt"]); // still staged
    expect(err.hint).toContain("still staged");
  });

  it("aborts when the index changes", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const provider = new FakeProvider(() => {
      repo.write("sneaky.txt", "s\n");
      repo.git("add", "sneaky.txt");
      return reply("feat: add a");
    });
    const ctx = makeContext(repo, { provider });

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toMatch(/staging area \(index\) changed/);
    expect(repo.log()).toHaveLength(1);
    expect(repo.staged().sort()).toEqual(["A a.txt", "A sneaky.txt"]);
  });

  it("aborts when the index changes by unstaging", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const provider = new FakeProvider(() => {
      repo.git("restore", "--staged", "a.txt");
      return reply("feat: add a");
    });
    const ctx = makeContext(repo, { provider });

    await failure(runCheckin(AUTO, ctx.deps));

    expect(repo.log()).toHaveLength(1);
  });

  it("aborts when the branch is switched to another branch at the same commit", async () => {
    const repo = createRepo();
    repo.git("branch", "twin");
    repo.write("a.txt", "a\n");
    const provider = new FakeProvider(() => {
      repo.git("switch", "-q", "twin");
      return reply("feat: add a");
    });
    const ctx = makeContext(repo, { provider });

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toMatch(/branch changed/);
    expect(repo.log()).toHaveLength(1);
  });

  it("aborts in a repository with no commits when a first commit appears meanwhile", async () => {
    const repo = createRepo({ commit: false });
    repo.write("a.txt", "a\n");
    const provider = new FakeProvider(() => {
      repo.git("commit", "-q", "-m", "someone else made the first commit");
      return reply("feat: add a");
    });
    const ctx = makeContext(repo, { provider });

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toMatch(/HEAD moved/);
    expect(repo.log()).toHaveLength(1);
    expect(repo.messages()[0]).toBe("someone else made the first commit");
  });

  it("aborts when a merge starts while generating", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const provider = new FakeProvider(() => {
      repo.write(".git/MERGE_HEAD", `${repo.head()}\n`);
      return reply("feat: add a");
    });
    const ctx = makeContext(repo, { provider });

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toMatch(/merge is in progress/);
    expect(repo.log()).toHaveLength(1);
  });
});

describe("commit execution", () => {
  it("keeps shell metacharacters in the message literal", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const nasty = 'fix: handle $(touch pwned) `touch pwned2` "quotes" \'single\' ; rm -rf / && echo $HOME | cat > x';
    const body = "- line with #hash and `backticks`\n# not a comment\n$(touch pwned3)\n\\n literal backslash-n";
    const ctx = makeContext(repo, { provider: new FakeProvider(reply(nasty.slice(0, 72), body)) });
    const subject = nasty.slice(0, 72);

    await runCheckin(AUTO, ctx.deps);

    expect(repo.messages()[0]).toBe(`${subject}\n\n${body}`);
    for (const f of ["pwned", "pwned2", "pwned3", "x"]) expect(repo.exists(f)).toBe(false);
  });

  it("appends the ticket id deterministically as a Refs footer", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const ctx = makeContext(repo, { provider: new FakeProvider(reply("feat: add a", "Adds a.")) });

    await runCheckin({ ...AUTO, ticket: "proj-123" }, ctx.deps);

    expect(repo.messages()[0]).toBe("feat: add a\n\nAdds a.\n\nRefs: PROJ-123");
    expect(ctx.io.text()).toContain("Jira is not configured");
  });

  it("does not bypass a failing pre-commit hook, and leaves the changes staged", async () => {
    const repo = createRepo();
    repo.hook("pre-commit", 'echo "lint failed: no semicolons allowed" >&2\nexit 1');
    repo.write("a.txt", "a\n");
    const ctx = makeContext(repo);

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toMatch(/git commit failed/);
    expect(err.hint).toMatch(/never bypassed/);
    expect(err.hint).toContain("still staged");
    expect(ctx.io.text()).toContain("lint failed: no semicolons allowed");
    expect(repo.log()).toHaveLength(1);
    expect(repo.staged()).toEqual(["A a.txt"]);
  });

  it("runs hooks that pass", async () => {
    const repo = createRepo();
    repo.hook("pre-commit", 'echo ran > "$(git rev-parse --git-dir)/hook-ran"');
    repo.hook("commit-msg", 'grep -q "^feat: " "$1"');
    repo.write("a.txt", "a\n");
    const ctx = makeContext(repo);

    await runCheckin(AUTO, ctx.deps);

    expect(repo.exists(".git/hook-ran")).toBe(true);
    expect(repo.log()).toHaveLength(2);
  });

  it("honours commit signing configuration instead of overriding it", async () => {
    const repo = createRepo();
    const failingGpg = join(makeTempDir("fake-gpg-"), "gpg");
    writeFileSync(failingGpg, "#!/bin/sh\necho 'gpg: signing failed: no secret key' >&2\nexit 2\n");
    chmodSync(failingGpg, 0o755);
    repo.git("config", "commit.gpgsign", "true");
    repo.git("config", "gpg.program", failingGpg);
    repo.write("a.txt", "a\n");
    const ctx = makeContext(repo);

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toMatch(/git commit failed/);
    expect(repo.log()).toHaveLength(1); // signing was attempted and was not bypassed
    expect(repo.staged()).toEqual(["A a.txt"]);
  });

  it("never pushes: a configured remote receives nothing", async () => {
    const repo = createRepo();
    const remote = makeTempDir("remote-");
    repo.git("init", "-q", "--bare", remote);
    repo.git("remote", "add", "origin", remote);
    repo.git("config", "push.default", "current");
    repo.write("a.txt", "a\n");

    await runCheckin(AUTO, makeContext(repo).deps);

    expect(repo.git("ls-remote", remote).trim()).toBe("");
  });
});

describe("failure handling leaves the index intact", () => {
  it("keeps changes staged when the provider fails", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    repo.write("src/app.txt", "changed\n");
    const provider = new FakeProvider(() => {
      throw new CheckinError("provider exploded");
    });
    const ctx = makeContext(repo, { provider });

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toBe("provider exploded");
    expect(err.hint).toContain("Your changes are still staged");
    expect(repo.staged().sort()).toEqual(["A a.txt", "M src/app.txt"]);
    expect(repo.log()).toHaveLength(1);
  });

  it("rejects invalid model output without committing", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const provider = new FakeProvider("this is not json", "still not json");
    const ctx = makeContext(repo, { provider });

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toMatch(/unusable commit message/);
    expect(provider.requests).toHaveLength(2); // one corrective re-ask, then give up
    expect(repo.log()).toHaveLength(1);
    expect(repo.staged()).toEqual(["A a.txt"]);
  });

  it("rejects an oversized diff before calling the provider, and says nothing was sent", async () => {
    const repo = createRepo();
    repo.write("big.txt", "x".repeat(5000));
    const ctx = makeContext(repo, { env: { CHECKIN_MAX_DIFF_BYTES: "1000" } });

    const err = await failure(runCheckin(AUTO, ctx.deps));

    expect(err.message).toMatch(/too large/);
    expect(err.hint).toContain("CHECKIN_MAX_DIFF_BYTES");
    expect(ctx.provider.requests).toHaveLength(0);
    expect(repo.log()).toHaveLength(1);
    expect(repo.staged()).toEqual(["A big.txt"]);
  });
});

describe("what the model is shown", () => {
  it("never runs external diff drivers or textconv filters", async () => {
    const repo = createRepo();
    const marker = join(makeTempDir("marker-"), "driver-ran");
    const driver = join(makeTempDir("driver-"), "driver.sh");
    writeFileSync(driver, `#!/bin/sh\ntouch "${marker}"\necho "EXTERNAL DIFF OUTPUT"\n`);
    chmodSync(driver, 0o755);
    repo.git("config", "diff.external", driver);
    repo.git("config", "diff.sneaky.textconv", driver);
    repo.write(".gitattributes", "*.conv diff=sneaky\n");
    repo.write("file.conv", "original\n");
    repo.write("plain.txt", "plain content\n");
    const ctx = makeContext(repo);

    await runCheckin({ ...AUTO, preview: true }, ctx.deps);

    expect(existsSync(marker)).toBe(false);
    const prompt = ctx.provider.requests[0]!.user;
    expect(prompt).not.toContain("EXTERNAL DIFF OUTPUT");
    expect(prompt).toContain("+plain content");
    expect(prompt).toContain("+original");
  });

  it("is not affected by user diff settings such as noprefix or color", async () => {
    const repo = createRepo();
    repo.git("config", "diff.noprefix", "true");
    repo.git("config", "color.diff", "always");
    repo.git("config", "color.ui", "always");
    repo.write("a.txt", "a\n");
    const ctx = makeContext(repo);

    await runCheckin({ ...AUTO, preview: true }, ctx.deps);

    const prompt = ctx.provider.requests[0]!.user;
    expect(prompt).toContain("diff --git a/a.txt b/a.txt");
    expect(prompt).not.toContain("\u001b[");
  });

  it("describes binary files by path only", async () => {
    const repo = createRepo();
    repo.write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff, 0x00]));
    const ctx = makeContext(repo);

    await runCheckin({ ...AUTO, preview: true }, ctx.deps);

    const prompt = ctx.provider.requests[0]!.user;
    expect(prompt).toContain("logo.png");
    expect(prompt).toContain("binary (content not shown)");
  });

  it("flags submodule pointer changes", async () => {
    const repo = createRepo();
    const sub = createRepo();
    repo.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.dir, "vendor/lib");
    repo.commitAll("chore: add submodule");
    sub.write("new.txt", "n\n");
    sub.commitAll("sub: advance");
    repo.git("-C", "vendor/lib", "-c", "protocol.file.allow=always", "pull", "-q", "origin", "main");
    expect(repo.git("status", "--porcelain")).toContain("vendor/lib");
    const ctx = makeContext(repo);

    await runCheckin({ ...AUTO, preview: true }, ctx.deps);

    const prompt = ctx.provider.requests[0]!.user;
    expect(prompt).toContain("vendor/lib");
    expect(prompt).toContain("submodule pointer");
  });

  it("includes renames as renames", async () => {
    const repo = createRepo();
    repo.git("mv", "src/app.txt", "src/renamed.txt");
    const ctx = makeContext(repo);

    await runCheckin({ ...AUTO, preview: true }, ctx.deps);

    expect(ctx.provider.requests[0]!.user).toContain("src/app.txt -> src/renamed.txt");
  });

  it("handles file names with spaces and unusual characters", async () => {
    const repo = createRepo();
    repo.write("my docs/ünïcode name.md", "hi\n");
    const ctx = makeContext(repo);

    await runCheckin(AUTO, ctx.deps);

    expect(repo.git("show", "--name-only", "--format=", "-z", "HEAD")).toContain("my docs/ünïcode name.md");
  });
});

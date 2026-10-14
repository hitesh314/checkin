import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "vitest";

const created: string[] = [];

afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function makeTempDir(prefix = "checkin-test-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

export interface TestRepo {
  dir: string;
  git(...args: string[]): string;
  write(path: string, content: string | Buffer): void;
  read(path: string): string;
  exists(path: string): boolean;
  remove(path: string): void;
  commitAll(message: string): string;
  hook(name: string, script: string): void;
  head(): string | null;
  log(): string[];
  /** Paths that `git commit` would record, as `X path` lines from `git diff --cached --name-status`. */
  staged(): string[];
  messages(): string[];
}

/** A throwaway repository on branch `main`. These tests never touch the repository this project lives in. */
export function createRepo(options: { commit?: boolean } = {}): TestRepo {
  const dir = makeTempDir();
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");

  const repo: TestRepo = {
    dir,
    git,
    write(path, content) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    read: (path) => readFileSync(join(dir, path), "utf8"),
    exists: (path) => existsSync(join(dir, path)),
    remove: (path) => rmSync(join(dir, path), { recursive: true, force: true }),
    commitAll(message) {
      git("add", "--all");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD").trim();
    },
    hook(name, script) {
      const path = join(dir, ".git", "hooks", name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `#!/bin/sh\n${script}\n`);
      chmodSync(path, 0o755);
    },
    head() {
      try {
        return git("rev-parse", "--verify", "-q", "HEAD").trim();
      } catch {
        return null;
      }
    },
    log() {
      try {
        return git("log", "--format=%H").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    staged() {
      return git("diff", "--cached", "--name-status").split("\n").filter(Boolean).map((l) => l.replace(/\t/g, " "));
    },
    messages() {
      try {
        return git("log", "--format=%B%x00").split("\0").map((m) => m.trim()).filter(Boolean);
      } catch {
        return [];
      }
    },
  };

  if (options.commit !== false) {
    repo.write("README.md", "# demo\n");
    repo.write("src/app.txt", "one\n");
    repo.commitAll("chore: initial commit");
  }
  return repo;
}

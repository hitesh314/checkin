import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { git, runGit } from "./exec.js";
import { CheckinError, UsageError } from "../util/errors.js";

/** Find the working-tree root, even when invoked from a subdirectory. */
export async function findRepoRoot(cwd: string): Promise<string> {
  const result = await runGit(["rev-parse", "--show-toplevel"], { cwd });
  const root = result.stdout.trim();
  if (result.code !== 0 || root === "") {
    throw new UsageError("Not inside a Git working tree.", {
      hint: "Run checkin from inside a Git repository (or run `git init` first).",
    });
  }
  return root;
}

export interface RepoState {
  root: string;
  /** Current commit, or null when the branch has no commits yet. */
  head: string | null;
  /** Full ref of the current branch (e.g. refs/heads/main), or null when HEAD is detached. */
  branchRef: string | null;
  /** Paths with unresolved merge conflicts. */
  unmerged: string[];
  /** Name of an unsupported in-progress operation, if any. */
  operation: string | null;
}

const OPERATION_MARKERS: Array<[string, string]> = [
  ["MERGE_HEAD", "merge"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase or `git am`"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["sequencer", "multi-commit cherry-pick or revert"],
  ["BISECT_LOG", "bisect"],
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function detectOperation(root: string): Promise<string | null> {
  const args = ["rev-parse"];
  for (const [marker] of OPERATION_MARKERS) args.push("--git-path", marker);
  const { stdout } = await git(args, { cwd: root });
  const paths = stdout.split("\n").filter((l) => l !== "");
  for (const [i, path] of paths.entries()) {
    // --git-path output is relative to the cwd we ran in (the repo root).
    if (await exists(resolve(root, path))) return OPERATION_MARKERS[i]?.[1] ?? "unknown";
  }
  return null;
}

async function readUnmerged(root: string): Promise<string[]> {
  const { stdout } = await git(["ls-files", "--unmerged", "-z"], { cwd: root });
  const paths = new Set<string>();
  for (const entry of stdout.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab !== -1) paths.add(entry.slice(tab + 1));
  }
  return [...paths].sort();
}

/** Resolve the current commit; `null` means an unborn branch (no commits yet). */
export async function readHead(root: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: root });
  if (result.code === 0) return result.stdout.trim();

  // Distinguish "no commits yet" from "HEAD is broken": an unborn branch has a
  // symbolic HEAD whose target ref does not exist.
  const ref = await readBranchRef(root);
  if (ref !== null) {
    const exists = await runGit(["show-ref", "--verify", "--quiet", ref], { cwd: root });
    if (exists.code !== 0) return null;
  }
  throw new CheckinError("Could not read HEAD; the repository may be corrupted.", {
    hint: "Run `git status` and `git fsck` to investigate.",
  });
}

export async function readBranchRef(root: string): Promise<string | null> {
  const result = await runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd: root });
  return result.code === 0 ? result.stdout.trim() : null;
}

export function branchName(ref: string | null): string | null {
  return ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

export async function inspectRepo(root: string): Promise<RepoState> {
  const [branchRef, operation, unmerged] = await Promise.all([
    readBranchRef(root),
    detectOperation(root),
    readUnmerged(root),
  ]);
  const head = operation === null && branchRef !== null ? await readHead(root) : await readHeadLoose(root);
  return { root, head, branchRef, unmerged, operation };
}

/** HEAD for states we are about to reject anyway: never throw, just report. */
async function readHeadLoose(root: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: root });
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Refuse repository states where an automatic commit would be wrong or
 * destructive. Order matters: operations first (they usually explain the
 * conflicts and the detached HEAD), then conflicts, then detached HEAD.
 */
export function assertCommittable(state: RepoState): void {
  if (state.operation !== null) {
    throw new UsageError(`A ${state.operation} is in progress; checkin does not support committing during one.`, {
      hint: "Finish or abort it with git (for example `git merge --continue` / `git merge --abort`), then run checkin again.",
    });
  }
  if (state.unmerged.length > 0) {
    const shown = state.unmerged.slice(0, 10).map((p) => `  ${p}`).join("\n");
    const more = state.unmerged.length > 10 ? `\n  … and ${state.unmerged.length - 10} more` : "";
    throw new UsageError(`Unresolved merge conflicts in ${state.unmerged.length} file(s):\n${shown}${more}`, {
      hint: "Resolve them and run `git add <file>` for each, then run checkin again. Nothing was staged.",
    });
  }
  if (state.branchRef === null) {
    throw new UsageError("HEAD is detached; checkin does not commit on a detached HEAD in this version.", {
      hint: "Create a branch to keep your work, for example `git switch -c my-branch`, then run checkin again.",
    });
  }
}

/** What the repository looked like when we started generating. */
export interface RepoSnapshot {
  head: string | null;
  branchRef: string | null;
  /** Object id of the tree that `git commit` would record. */
  stagedTree: string;
}

export async function takeSnapshot(root: string): Promise<RepoSnapshot> {
  const [head, branchRef] = await Promise.all([readHead(root), readBranchRef(root)]);
  const { stdout } = await git(["write-tree"], { cwd: root });
  return { head, branchRef, stagedTree: stdout.trim() };
}

export function describeSnapshotChange(before: RepoSnapshot, after: RepoSnapshot): string[] {
  const changes: string[] = [];
  if (before.branchRef !== after.branchRef) changes.push("the checked-out branch changed");
  if (before.head !== after.head) changes.push("HEAD moved (a commit, reset, or checkout happened)");
  if (before.stagedTree !== after.stagedTree) changes.push("the staging area (index) changed");
  return changes;
}

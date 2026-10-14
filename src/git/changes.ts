import { git, runGit } from "./exec.js";
import { CheckinError } from "../util/errors.js";
import { isEnvironmentFile } from "./envfiles.js";

/**
 * Flags that make `git diff` output deterministic regardless of the user's
 * git config: no external diff drivers, no textconv filters, no color, no
 * pager, stable path prefixes, and submodule pointer changes always shown.
 */
const DIFF_FLAGS = [
  "--cached",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--find-renames",
  "--ignore-submodules=none",
  "--submodule=short",
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const;

export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X";

export interface StagedFile {
  path: string;
  /** Previous path for renames and copies. */
  oldPath?: string;
  status: ChangeStatus;
  /** Git reports no text diff (binary content). */
  binary: boolean;
  /** A submodule (gitlink) pointer changed; only commit ids are visible. */
  submodule: boolean;
  additions: number | null;
  deletions: number | null;
}

/** Paths with changes that `git add --all` would stage: modified, deleted, and untracked (not ignored) files. */
async function listChangedPaths(root: string): Promise<string[]> {
  const result = await runGit(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root });
  if (result.code !== 0) {
    throw new CheckinError(`git status failed:\n${(result.stderr || result.stdout).trim()}`);
  }
  const tokens = result.stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i] ?? "";
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // Renames/copies are followed by the original path as a separate token.
    if (/[RC]/.test(entry.slice(0, 2))) i += 1;
  }
  return paths;
}

export interface StageResult {
  /** Changed environment files that were deliberately left unstaged. */
  skippedEnvFiles: string[];
}

/**
 * Stage every change under the repository root (additions, modifications,
 * deletions; `.gitignore` respected) — except environment files, which are
 * reported in `skippedEnvFiles` and left exactly as they were.
 *
 * Equivalent to `git add --all` minus those files. Paths are passed to git on
 * stdin and treated literally, so unusual file names (spaces, `*`, `[`, a
 * leading `-`) are safe.
 */
export async function stageAll(root: string): Promise<StageResult> {
  const changed = await listChangedPaths(root);
  const skippedEnvFiles = changed.filter(isEnvironmentFile).sort();
  const toStage = changed.filter((p) => !isEnvironmentFile(p));

  if (toStage.length > 0) {
    const result = await runGit(
      ["--literal-pathspecs", "add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"],
      { cwd: root, input: `${toStage.join("\0")}\0` },
    );
    if (result.code !== 0) {
      throw new CheckinError(`git add --all failed:\n${(result.stderr || result.stdout).trim()}`, {
        hint: "Fix the problem above (for example a stale .git/index.lock) and run checkin again. Nothing was committed.",
      });
    }
  }
  return { skippedEnvFiles };
}

interface RawEntry {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  submodule: boolean;
}

function parseRaw(output: string): RawEntry[] {
  const tokens = output.split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (!token.startsWith(":")) continue;
    const fields = token.slice(1).split(" ");
    const [oldMode = "", newMode = "", , , rawStatus = "X"] = fields;
    const letter = rawStatus.charAt(0);
    const status = ("AMDRCTU".includes(letter) ? letter : "X") as ChangeStatus;
    const submodule = oldMode === "160000" || newMode === "160000";
    if (status === "R" || status === "C") {
      const oldPath = tokens[++i] ?? "";
      const path = tokens[++i] ?? "";
      entries.push({ path, oldPath, status, submodule });
    } else {
      entries.push({ path: tokens[++i] ?? "", status, submodule });
    }
  }
  return entries;
}

interface NumstatEntry {
  path: string;
  additions: number | null;
  deletions: number | null;
}

function parseNumstat(output: string): Map<string, NumstatEntry> {
  const tokens = output.split("\0");
  const map = new Map<string, NumstatEntry>();
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i] ?? "");
    if (!match) continue;
    const additions = match[1] === "-" ? null : Number(match[1]);
    const deletions = match[2] === "-" ? null : Number(match[2]);
    let path = match[3] ?? "";
    if (path === "") {
      // Rename/copy: "<add>\t<del>\t\0old\0new\0"
      i += 1; // old path
      path = tokens[++i] ?? "";
    }
    map.set(path, { path, additions, deletions });
  }
  return map;
}

/** File-level summary of what is currently staged. */
export async function readStagedSummary(root: string): Promise<StagedFile[]> {
  const [raw, numstat] = await Promise.all([
    git(["--no-pager", "diff", ...DIFF_FLAGS, "--raw", "-z"], { cwd: root }),
    git(["--no-pager", "diff", ...DIFF_FLAGS, "--numstat", "-z"], { cwd: root }),
  ]);
  const stats = parseNumstat(numstat.stdout);
  return parseRaw(raw.stdout).map((entry) => {
    const stat = stats.get(entry.path);
    const additions = stat?.additions ?? null;
    const deletions = stat?.deletions ?? null;
    // numstat prints "-\t-" for binary files; submodules have no text stats either.
    const binary = !entry.submodule && stat !== undefined && additions === null && deletions === null;
    const file: StagedFile = {
      path: entry.path,
      status: entry.status,
      binary,
      submodule: entry.submodule,
      additions,
      deletions,
    };
    if (entry.oldPath !== undefined) file.oldPath = entry.oldPath;
    return file;
  });
}

export interface StagedDiff {
  text: string;
  bytes: number;
  /** True when the diff exceeded `maxBytes`; `text` is then incomplete and must not be sent to a provider. */
  exceeded: boolean;
}

/** Read the staged patch, stopping early once it is larger than `maxBytes`. */
export async function readStagedDiff(root: string, maxBytes: number): Promise<StagedDiff> {
  const result = await runGit(["--no-pager", "diff", ...DIFF_FLAGS], { cwd: root, maxBytes });
  if (result.code !== 0) {
    throw new CheckinError(`git diff --cached failed:\n${(result.stderr || result.stdout).trim()}`);
  }
  return {
    text: result.truncated ? "" : result.stdout,
    bytes: Buffer.byteLength(result.stdout),
    exceeded: result.truncated,
  };
}

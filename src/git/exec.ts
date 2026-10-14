import { spawn } from "node:child_process";
import { CheckinError } from "../util/errors.js";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when output exceeded `maxBytes` and the child was stopped early. */
  truncated: boolean;
}

export interface GitRunOptions {
  cwd: string;
  /** Stop reading (and kill git) once stdout exceeds this many bytes. */
  maxBytes?: number;
  /** Written to git's stdin (e.g. a NUL-separated pathspec list). */
  input?: string;
}

/**
 * Run git with an argument array. There is no shell involved anywhere, so
 * nothing in `args` (file names, generated commit messages, …) is ever
 * interpreted by a shell.
 */
export function runGit(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: options.cwd,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: process.env,
      shell: false,
    });

    if (options.input !== undefined) {
      child.stdin?.on("error", () => undefined); // git may exit before reading everything; its exit code tells the story
      child.stdin?.end(options.input);
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      out.push(chunk);
      outBytes += chunk.length;
      if (options.maxBytes !== undefined && outBytes > options.maxBytes) {
        truncated = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (err.length < 1024) err.push(chunk);
    });

    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") {
        reject(new CheckinError("`git` was not found on your PATH.", { hint: "Install Git (https://git-scm.com) and try again." }));
      } else {
        reject(e);
      }
    });
    child.on("close", (code) => {
      resolve({
        code: truncated ? 0 : (code ?? 1),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        truncated,
      });
    });
  });
}

export class GitCommandError extends CheckinError {
  constructor(
    readonly args: readonly string[],
    readonly result: GitResult,
  ) {
    const detail = (result.stderr || result.stdout).trim();
    super(`git ${args[0] ?? ""} failed (exit ${result.code})${detail ? `:\n${detail}` : ""}`);
  }
}

/** Run git and throw if it exits non-zero. */
export async function git(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
  const result = await runGit(args, options);
  if (result.code !== 0) throw new GitCommandError(args, result);
  return result;
}

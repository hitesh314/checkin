import { spawn } from "node:child_process";
import { git } from "./exec.js";
import { CheckinError } from "../util/errors.js";

export interface CommitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommitOptions {
  /**
   * Let git (and any hooks / signing prompts) talk to the user's terminal
   * directly. Output is then not captured. Tests use `false` to capture it.
   */
  inheritStdio: boolean;
}

/**
 * `git commit -m <message>` via an argument array.
 *
 * - No shell is involved, so quotes, `$()`, backticks, `;`, `&&` and friends in
 *   the message are literal text.
 * - Hooks and commit signing are left exactly as the user configured them:
 *   no `--no-verify`, no `--no-gpg-sign`, no `-c` overrides except
 *   `--cleanup=whitespace`, which keeps lines starting with `#` verbatim.
 * - It commits what is in the index and nothing else (no `-a`, no pathspec).
 */
export function runCommit(root: string, message: string, options: CommitOptions): Promise<CommitResult> {
  return new Promise((resolve, reject) => {
    const args = ["commit", "--cleanup=whitespace", "-m", message];
    const child = spawn("git", args, {
      cwd: root,
      stdio: options.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
      env: process.env,
      shell: false,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => reject(new CheckinError(`Could not run git commit: ${e.message}`)));
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
}

export async function shortHead(root: string): Promise<string> {
  const { stdout } = await git(["rev-parse", "--short", "HEAD"], { cwd: root });
  return stdout.trim();
}

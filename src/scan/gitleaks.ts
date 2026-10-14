import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CheckinError } from "../util/errors.js";

/**
 * Secret scanning of the staged changes with Gitleaks (https://github.com/gitleaks/gitleaks).
 *
 * checkin runs the user's own `gitleaks` binary — nothing is bundled and nothing
 * is uploaded. Only the rule id, file name and line number of a finding are ever
 * read or printed: never the matched secret itself (and gitleaks is asked to
 * redact it anyway).
 */

export type SecretScanMode = "auto" | "required" | "off";

export function resolveScanMode(env: Record<string, string | undefined>): SecretScanMode {
  const raw = env.CHECKIN_SECRET_SCAN?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "auto") return "auto";
  if (raw === "required" || raw === "off") return raw;
  throw new CheckinError(`CHECKIN_SECRET_SCAN must be "auto", "required" or "off" (got "${env.CHECKIN_SECRET_SCAN}").`);
}

/** Where the postinstall step puts the pinned gitleaks (`<package>/vendor`). Same relative depth from src/ and dist/. */
export function bundledGitleaksPath(platform: string = process.platform): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vendor", platform === "win32" ? "gitleaks.exe" : "gitleaks");
}

export interface ResolvedGitleaks {
  command: string;
  source: "CHECKIN_GITLEAKS_PATH" | "bundled" | "PATH";
}

/** Which gitleaks to run: an explicit path, else the copy installed with checkin, else whatever is on PATH. */
export function resolveGitleaksCommand(
  env: Record<string, string | undefined>,
  bundled: string = bundledGitleaksPath(),
  exists: (path: string) => boolean = existsSync,
): ResolvedGitleaks {
  const explicit = env.CHECKIN_GITLEAKS_PATH?.trim();
  if (explicit) return { command: explicit, source: "CHECKIN_GITLEAKS_PATH" };
  if (exists(bundled)) return { command: bundled, source: "bundled" };
  return { command: "gitleaks", source: "PATH" };
}

export interface SecretFinding {
  rule: string;
  file: string;
  line: number | undefined;
}

export type ScanResult =
  | { status: "clean"; version: string }
  | { status: "findings"; findings: SecretFinding[] }
  | { status: "unavailable"; reason: string }
  | { status: "error"; reason: string };

export interface SecretScanner {
  /** Scan the staged changes of the repository at `root`. Must never throw for scanner problems; report them in the result. */
  scanStaged(root: string): Promise<ScanResult>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell. Resolves `null` if it is not installed and throws on timeout. */
export type CommandRunner = (command: string, args: readonly string[], options: { cwd: string; timeoutMs: number }) => Promise<CommandResult | null>;

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export const runCommand: CommandRunner = (command, args, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false, env: process.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let overflow = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill("SIGTERM");
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (err.length < 64) err.push(chunk);
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === "ENOENT" || e.code === "EACCES") resolve(null);
      else reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
      if (overflow) return reject(new Error("produced too much output"));
      resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });

/** Exit code that means "leaks found" (chosen so it cannot be confused with gitleaks' generic failure code 1). */
const LEAKS_EXIT_CODE = 2;

export interface GitleaksOptions {
  /** Binary name or path. Defaults to `gitleaks` on PATH. */
  command?: string;
  timeoutMs?: number;
  run?: CommandRunner;
}

/** `gitleaks git --staged` replaced `gitleaks protect --staged` in 8.19. */
export function usesGitSubcommand(version: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(version);
  if (!m) return true; // unknown format: assume a current release
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 8 || (major === 8 && minor >= 19);
}

export function parseFindings(stdout: string): SecretFinding[] | null {
  const text = stdout.trim();
  if (text === "") return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  return data.map((item): SecretFinding => {
    const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return {
      rule: typeof o.RuleID === "string" && o.RuleID !== "" ? o.RuleID : "unknown-rule",
      file: typeof o.File === "string" && o.File !== "" ? o.File : "(unknown file)",
      line: typeof o.StartLine === "number" ? o.StartLine : undefined,
    };
  });
}

export function createGitleaksScanner(options: GitleaksOptions = {}): SecretScanner {
  const command = options.command ?? "gitleaks";
  const timeoutMs = options.timeoutMs ?? 60_000;
  const run = options.run ?? runCommand;

  return {
    async scanStaged(root) {
      let version: string;
      try {
        const v = await run(command, ["version"], { cwd: root, timeoutMs: Math.min(timeoutMs, 15_000) });
        if (v === null) return { status: "unavailable", reason: `\`${command}\` was not found on your PATH` };
        version = `${v.stdout}`.trim().split(/\r?\n/)[0] ?? "";
        if (v.code !== 0) return { status: "error", reason: `\`${command} version\` failed (exit ${v.code})` };
      } catch (e) {
        return { status: "error", reason: `could not run \`${command} version\`: ${(e as Error).message}` };
      }

      const args = [
        usesGitSubcommand(version) ? "git" : "protect",
        "--staged",
        "--no-banner",
        "--no-color",
        "--redact",
        "--log-level",
        "error",
        "--exit-code",
        String(LEAKS_EXIT_CODE),
        "--report-format",
        "json",
        "--report-path",
        "-",
      ];

      let result: CommandResult | null;
      try {
        result = await run(command, args, { cwd: root, timeoutMs });
      } catch (e) {
        return { status: "error", reason: `${command} ${(e as Error).message}` };
      }
      if (result === null) return { status: "unavailable", reason: `\`${command}\` was not found on your PATH` };

      if (result.code === 0) return { status: "clean", version };
      if (result.code === LEAKS_EXIT_CODE) {
        const findings = parseFindings(result.stdout);
        // Leaks were reported even if we cannot read the details: fail closed.
        return { status: "findings", findings: findings ?? [] };
      }
      const detail = result.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? "";
      return { status: "error", reason: `${command} exited with code ${result.code}${detail ? `: ${detail.slice(0, 200)}` : ""}` };
    },
  };
}

const MAX_LISTED = 10;

export function describeFindings(findings: readonly SecretFinding[]): string {
  if (findings.length === 0) return "gitleaks reported possible secrets (details could not be read)";
  const lines = findings.slice(0, MAX_LISTED).map((f) => `  ${f.file}${f.line !== undefined ? `:${f.line}` : ""}  (${f.rule})`);
  if (findings.length > MAX_LISTED) lines.push(`  …and ${findings.length - MAX_LISTED} more`);
  return `Possible secret${findings.length === 1 ? "" : "s"} found in the staged changes:\n${lines.join("\n")}`;
}

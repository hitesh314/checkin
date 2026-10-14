import { createProvider } from "../ai/registry.js";
import type { AiProvider, ProviderOptions } from "../ai/types.js";
import { loadConfig, type ConfigLocation } from "../config/config.js";
import { resolveJira, resolveLimits, resolveProvider } from "../config/settings.js";
import type { SecretStore } from "../credentials/store.js";
import { generateCommitMessage, DEFAULT_MAX_OUTPUT_TOKENS, InputTooLargeError, type GeneratedMessage } from "../generate/generate.js";
import { readStagedDiff, readStagedSummary, stageAll, type StagedFile } from "../git/changes.js";
import { runCommit, shortHead } from "../git/commit.js";
import { isEnvironmentFile } from "../git/envfiles.js";
import {
  assertCommittable,
  branchName,
  describeSnapshotChange,
  findRepoRoot,
  inspectRepo,
  takeSnapshot,
} from "../git/repo.js";
import { JiraClient } from "../jira/client.js";
import { chooseTicket } from "../jira/ticket.js";
import type { JiraContext } from "../prompt/build.js";
import { appendHint, CheckinError } from "../util/errors.js";
import type { FetchLike, Sleep } from "../util/http.js";
import type { Io } from "../util/io.js";
import { secretVariants } from "../util/redact.js";
import { createGitleaksScanner, describeFindings, resolveGitleaksCommand, resolveScanMode, type SecretScanMode, type SecretScanner } from "../scan/gitleaks.js";

export interface CheckinOptions {
  /** Explicit Jira ticket (`--ticket`). */
  ticket?: string;
  /** Stage and generate, but do not commit. */
  preview: boolean;
  /** Use only what is already staged; do not run `git add --all`. */
  staged: boolean;
}

export interface CheckinDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  io: Io;
  fetch: FetchLike;
  sleep: Sleep;
  secrets: SecretStore;
  configLocation: ConfigLocation;
  /** Let git talk to the terminal directly (hooks, signing prompts). Tests set this to false to capture output. */
  inheritCommitStdio: boolean;
  /** Test seam; defaults to the user's `gitleaks` binary (see CHECKIN_SECRET_SCAN, CHECKIN_GITLEAKS_PATH). */
  secretScanner?: SecretScanner;
  /** Test seam; defaults to the real adapters. */
  providerFactory?: (id: Parameters<typeof createProvider>[0], options: ProviderOptions) => AiProvider;
}

export type CheckinOutcome = "committed" | "previewed" | "nothing";

const STILL_STAGED = "Your changes are still staged. Nothing was reset, discarded, or committed.";

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => (l === "" ? "" : `  ${l}`))
    .join("\n");
}

function summarise(files: StagedFile[], diffBytes: number): string {
  const binary = files.filter((f) => f.binary).length;
  const subs = files.filter((f) => f.submodule).length;
  const extras = [binary ? `${binary} binary` : "", subs ? `${subs} submodule pointer` : ""].filter(Boolean).join(", ");
  return `${files.length} file${files.length === 1 ? "" : "s"}${extras ? ` (${extras})` : ""}, ${diffBytes} byte diff`;
}

/**
 * The whole `checkin` run: guard → configure → stage → snapshot → read →
 * (Jira) → generate → verify → commit. Throws CheckinError on any failure;
 * after staging, failures never touch the index.
 */
export async function runCheckin(options: CheckinOptions, deps: CheckinDeps): Promise<CheckinOutcome> {
  const { io } = deps;

  // 1. Read-only checks first: nothing is modified until the repository is known to be in a supported state.
  const root = await findRepoRoot(deps.cwd);
  const state = await inspectRepo(root);
  assertCommittable(state);
  const branch = branchName(state.branchRef);

  // 2. Resolve configuration and credentials before staging, so a config problem never leaves a mutated index.
  const config = await loadConfig(deps.configLocation);
  const limits = resolveLimits(config, deps.env);
  const resolved = await resolveProvider(config, deps.env, deps.secrets);
  const jiraSettings = await resolveJira(config, deps.env, deps.secrets);
  if (resolved.apiKey) io.addSecrets(resolved.apiKey);
  if (jiraSettings) io.addSecrets(...secretVariants(jiraSettings.token, jiraSettings.email));
  const scanMode = resolveScanMode(deps.env);
  const ticket = chooseTicket({ flag: options.ticket, branch, jiraConfigured: jiraSettings !== null });

  const factory = deps.providerFactory ?? createProvider;
  const providerOptions: ProviderOptions = {
    model: resolved.model,
    timeoutMs: limits.timeoutMs,
    maxAttempts: limits.maxAttempts,
    fetch: deps.fetch,
    sleep: deps.sleep,
  };
  if (resolved.apiKey !== undefined) providerOptions.apiKey = resolved.apiKey;
  if (resolved.host !== undefined) providerOptions.host = resolved.host;
  const provider = factory(resolved.provider, providerOptions);

  let staged = false;
  try {
    // 3. Stage.
    let skippedEnvFiles: string[] = [];
    if (options.staged) {
      io.out("Using already-staged changes only (--staged).");
    } else {
      skippedEnvFiles = (await stageAll(root)).skippedEnvFiles;
      staged = true;
    }

    // 4. Record HEAD + staged tree *before* reading the diff or calling anything slow.
    const before = await takeSnapshot(root);
    const files = await readStagedSummary(root);
    if (files.length === 0) {
      io.out(options.staged ? "Nothing is staged; nothing to commit." : "Nothing to commit.");
      reportSkippedEnvFiles(io, skippedEnvFiles);
      return "nothing";
    }

    // Never send (or commit) an environment file, however it got staged.
    const stagedEnv = files.filter((f) => isEnvironmentFile(f.path) || (f.oldPath !== undefined && isEnvironmentFile(f.oldPath)));
    if (stagedEnv.length > 0) {
      const names = [...new Set(stagedEnv.flatMap((f) => (f.oldPath !== undefined ? [f.path, f.oldPath] : [f.path])))].filter(isEnvironmentFile);
      throw new CheckinError(`Environment file(s) are staged: ${names.join(", ")}`, {
        hint:
          "checkin never commits or sends environment files. Unstage them (git restore --staged -- <file>, or git rm --cached -- <file> to stop tracking) " +
          "and consider adding them to .gitignore. Nothing was sent to the AI provider and nothing was committed.",
      });
    }

    if (!options.staged) io.out(`Staged all changes under ${root} (environment files excluded)`);
    reportSkippedEnvFiles(io, skippedEnvFiles);

    // Scan for secrets *before* reading the diff, so a finding means nothing was sent anywhere.
    await scanForSecrets(root, scanMode, deps);
    const diff = await readStagedDiff(root, limits.maxDiffBytes);
    if (diff.exceeded) throw new InputTooLargeError(`more than ${limits.maxDiffBytes} bytes`, limits.maxDiffBytes);

    // 5. Ticket context (only when Jira is configured and a ticket was chosen).
    let jira: JiraContext | undefined;
    if (ticket !== null && jiraSettings !== null) {
      io.out(`Fetching Jira ticket ${ticket.key} (${ticket.source === "flag" ? "from --ticket" : "from branch name"})…`);
      const client = new JiraClient(jiraSettings, {
        fetch: deps.fetch,
        sleep: deps.sleep,
        timeoutMs: limits.timeoutMs,
        maxAttempts: limits.maxAttempts,
      });
      jira = await client.getIssue(ticket.key);
    } else if (ticket !== null) {
      io.err(`Jira is not configured, so ticket ${ticket.key} will be referenced but its details will not be fetched.`);
    }

    // 6. Generate.
    io.out(`Generating commit message with ${provider.id}/${provider.model} for ${summarise(files, diff.bytes)}…`);
    const generated: GeneratedMessage = await generateCommitMessage(
      {
        branch,
        files,
        diff: diff.text,
        ...(jira ? { jira } : {}),
        ...(ticket ? { ticketId: ticket.key } : {}),
      },
      { provider, maxDiffBytes: limits.maxDiffBytes, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS },
    );
    io.out("Commit message:");
    io.out(indent(generated.message));

    if (options.preview) {
      io.out("Preview only: nothing was committed.");
      if (!options.staged) {
        io.out(
          "Note: preview stages your changes (git add --all) and leaves them staged. " +
            `To unstage them yourself, run \`${before.head === null ? "git rm -r --cached ." : "git restore --staged ."}\`. checkin never does this for you.`,
        );
      }
      return "previewed";
    }

    // 7. Verify nothing moved while we were generating, then commit exactly what we described.
    assertCommittable(await inspectRepo(root));
    const after = await takeSnapshot(root);
    const changes = describeSnapshotChange(before, after);
    if (changes.length > 0) {
      throw new CheckinError(`The repository changed while the message was being generated: ${changes.join("; ")}.`, {
        hint: "Nothing was committed, because the message may no longer match what would be committed. Run checkin again.",
      });
    }

    const result = await runCommit(root, generated.message, { inheritStdio: deps.inheritCommitStdio });
    if (result.stdout) io.out(result.stdout.trimEnd());
    if (result.stderr) io.err(result.stderr.trimEnd());
    if (result.code !== 0) {
      throw new CheckinError(`git commit failed (exit code ${result.code}); no commit was created.`, {
        hint: "If a hook rejected the commit, fix what it reports and run checkin again. Hooks are never bypassed.",
      });
    }
    io.out(`Committed ${await shortHead(root)} on ${branch ?? "HEAD"}: ${generated.subject}`);
    return "committed";
  } catch (e) {
    if (e instanceof CheckinError) {
      const hasStaged = staged || options.staged;
      if (hasStaged) appendHint(e, STILL_STAGED);
    }
    throw e;
  }
}

function reportSkippedEnvFiles(io: Io, skipped: readonly string[]): void {
  if (skipped.length === 0) return;
  io.out(`Skipped ${skipped.length} environment file${skipped.length === 1 ? "" : "s"} (left unstaged): ${skipped.join(", ")}`);
}

const SCAN_HINT =
  "Nothing was sent to the AI provider and nothing was committed. Remove the secret (and rotate it if it was ever real), or unstage the file " +
  "(git restore --staged -- <file>). For a false positive, add a `gitleaks:allow` comment on that line or list it in .gitleaksignore. " +
  "To turn scanning off: CHECKIN_SECRET_SCAN=off.";

async function scanForSecrets(root: string, mode: SecretScanMode, deps: CheckinDeps): Promise<void> {
  if (mode === "off") return;
  const { io, env } = deps;
  const scanner: SecretScanner = deps.secretScanner ?? createGitleaksScanner({ command: resolveGitleaksCommand(env).command });
  const result = await scanner.scanStaged(root);

  switch (result.status) {
    case "clean":
      io.out("Secret scan (gitleaks): no secrets found in the staged changes.");
      return;
    case "findings":
      throw new CheckinError(describeFindings(result.findings), { hint: SCAN_HINT });
    case "unavailable":
    case "error": {
      const what = result.status === "unavailable" ? "gitleaks is not available" : "the secret scan failed";
      if (mode === "required") {
        throw new CheckinError(`CHECKIN_SECRET_SCAN=required, but ${what}: ${result.reason}.`, {
          hint: "Reinstall the bundled copy (`npm run install-gitleaks` in the checkin package), install gitleaks yourself (`brew install gitleaks`), or fix the problem above. Nothing was sent or committed.",
        });
      }
      io.err(
        `Warning: ${what} (${result.reason}), so the staged changes were NOT scanned for secrets. ` +
          "Reinstall it with `npm run install-gitleaks` in the checkin package (or `brew install gitleaks`), or set CHECKIN_SECRET_SCAN=off to silence this, or =required to refuse to run without it.",
      );
      return;
    }
  }
}

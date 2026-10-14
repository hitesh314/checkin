import { readFileSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { createProvider } from "./ai/registry.js";
import type { AiProvider, ProviderOptions } from "./ai/types.js";
import { runDoctor } from "./commands/doctor.js";
import { createClackPrompter, type Prompter } from "./commands/prompter.js";
import { runSetup } from "./commands/setup.js";
import { configLocation as defaultConfigLocation, type ConfigLocation } from "./config/config.js";
import { createKeyringStore, type SecretStore } from "./credentials/store.js";
import { runCheckin } from "./workflow/checkin.js";
import { CheckinError, UsageError } from "./util/errors.js";
import { realSleep, type FetchLike, type Sleep } from "./util/http.js";
import { createProcessIo, type Io } from "./util/io.js";
import { redact } from "./util/redact.js";

export interface CliDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  io: Io;
  fetch: FetchLike;
  sleep: Sleep;
  secrets: SecretStore;
  configLocation: ConfigLocation;
  prompter: () => Prompter;
  /** True when stdin/stdout are a terminal; `setup` needs one. */
  interactive: boolean;
  inheritCommitStdio: boolean;
  providerFactory?: (id: Parameters<typeof createProvider>[0], options: ProviderOptions) => AiProvider;
}

export const HELP_TEXT = `
What checkin does:
  Stages your changes, asks the AI provider you configured to write a Conventional
  Commit message from the staged diff (plus optional Jira ticket context), and runs
  \`git commit\` with it. There is no confirmation prompt.

How staging works:
  • By default, checkin stages like \`git add --all\` at the repository root (even if you
    run it from a subdirectory): new, modified and deleted files everywhere in the
    repository, respecting .gitignore. Everything staged is sent to the AI provider.
  • Environment files are never staged: .env, .env.*, *.env, .envrc and anything inside
    a .env/ directory, at any depth (templates .env.example/.sample/.template/.dist are
    allowed). Skipped files are listed and left untouched. If one is already staged
    (including with --staged), checkin stops before sending or committing anything.
  • With --staged, checkin never runs \`git add\`: it uses exactly what you have already
    staged (for example with \`git add -p\`) and leaves unstaged changes alone.
  • --preview generates the message but does not commit. Without --staged it has still
    staged everything (it will not undo that). Combine --preview --staged for a
    side-effect-free preview of your current index.

Safety:
  • Staged changes are scanned for secrets with gitleaks (if installed) before anything is
    sent to the AI provider; a finding stops the run. See CHECKIN_SECRET_SCAN.
  • checkin refuses to run during a merge, rebase, cherry-pick, revert or bisect, with
    unresolved conflicts, or on a detached HEAD.
  • If HEAD or the staged tree changes while the message is being generated, nothing is
    committed. (This narrows, but cannot eliminate, races with other git processes.)
  • Git hooks and commit signing run as usual and are never bypassed. checkin never
    pushes, resets, or discards anything. After a failure your changes stay staged.
  • Diffs larger than the limit are rejected, never silently truncated.
    Binary files and submodule pointers are described by path only: their contents are
    not visible to the model.

Examples:
  checkin                       stage everything, generate, commit
  checkin --ticket PROJ-123     add Jira context and a "Refs: PROJ-123" footer
  checkin --staged              commit only what is already staged
  checkin --preview --staged    show the message for the current index; change nothing
  checkin setup                 choose provider, model, credentials, Jira
  checkin doctor                check configuration and connectivity

Environment:
  CHECKIN_PROVIDER, CHECKIN_MODEL, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY,
  OLLAMA_HOST, CHECKIN_JIRA_SITE_URL / _EMAIL / _API_TOKEN / _AUTH_TYPE / _CLOUD_ID,
  CHECKIN_MAX_DIFF_BYTES, CHECKIN_TIMEOUT_MS, CHECKIN_CONFIG_DIR,
  CHECKIN_SECRET_SCAN (auto | required | off), CHECKIN_GITLEAKS_PATH.
  Environment variables override saved settings and stored credentials.
`;

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface ParsedOptions {
  ticket?: string;
  preview?: boolean;
  staged?: boolean;
}

/** Run the CLI and return the process exit code. Never calls process.exit. */
export async function run(argv: string[], deps: CliDeps): Promise<number> {
  let exitCode = 0;
  const program = new Command();
  program
    .name("checkin")
    .description("Stage changes, generate a commit message with AI, and commit — in one command.")
    .version(readVersion(), "-V, --version", "print the version")
    .helpOption("-h, --help", "show usage and how staging works")
    .option("--ticket <key>", "Jira ticket to use as context, e.g. PROJ-123")
    .option("--preview", "stage and generate the message, but do not commit")
    .option("--staged", "use only already-staged changes; do not stage anything")
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({
      writeOut: (s) => deps.io.out(s.replace(/\n$/, "")),
      writeErr: (s) => deps.io.err(s.replace(/\n$/, "")),
    })
    .addHelpText("after", HELP_TEXT);

  const rejectWorkflowFlags = (command: string): void => {
    const opts = program.opts<ParsedOptions>();
    const given = [opts.ticket !== undefined && "--ticket", opts.preview && "--preview", opts.staged && "--staged"].filter(Boolean);
    if (given.length > 0) throw new UsageError(`${given.join(", ")} cannot be used with \`checkin ${command}\`.`);
  };

  program
    .command("setup")
    .description("configure provider, model, credentials, and optional Jira")
    .action(async () => {
      rejectWorkflowFlags("setup");
      if (!deps.interactive) {
        throw new UsageError("`checkin setup` is interactive and needs a terminal.", {
          hint: "Run it in a terminal, or configure with environment variables (see `checkin --help`).",
        });
      }
      await runSetup({
        env: deps.env,
        io: deps.io,
        prompter: deps.prompter(),
        secrets: deps.secrets,
        configLocation: deps.configLocation,
        fetch: deps.fetch,
        sleep: deps.sleep,
      });
    });

  program
    .command("doctor")
    .description("diagnose configuration and connectivity")
    .action(async () => {
      rejectWorkflowFlags("doctor");
      const ok = await runDoctor({
        cwd: deps.cwd,
        env: deps.env,
        io: deps.io,
        secrets: deps.secrets,
        configLocation: deps.configLocation,
        fetch: deps.fetch,
        sleep: deps.sleep,
      });
      if (!ok) exitCode = 1;
    });

  program.action(async () => {
    const opts = program.opts<ParsedOptions>();
    await runCheckin(
      {
        preview: opts.preview === true,
        staged: opts.staged === true,
        ...(opts.ticket !== undefined ? { ticket: opts.ticket } : {}),
      },
      {
        cwd: deps.cwd,
        env: deps.env,
        io: deps.io,
        fetch: deps.fetch,
        sleep: deps.sleep,
        secrets: deps.secrets,
        configLocation: deps.configLocation,
        inheritCommitStdio: deps.inheritCommitStdio,
        ...(deps.providerFactory ? { providerFactory: deps.providerFactory } : {}),
      },
    );
  });

  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (e) {
    if (e instanceof CommanderError) {
      // Help and version are "errors" under exitOverride; commander has already printed its message.
      return e.exitCode === 0 ? 0 : 2;
    }
    if (e instanceof CheckinError) {
      deps.io.err(`error: ${e.message}`);
      if (e.hint) deps.io.err(e.hint);
      return e.exitCode;
    }
    deps.io.err(`error: unexpected failure: ${redact(e instanceof Error ? e.message : String(e))}`);
    return 1;
  }
}

export function createDefaultDeps(): CliDeps {
  return {
    cwd: process.cwd(),
    env: process.env,
    io: createProcessIo(),
    fetch: globalThis.fetch,
    sleep: realSleep,
    secrets: createKeyringStore(),
    configLocation: defaultConfigLocation(process.env),
    prompter: createClackPrompter,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    inheritCommitStdio: true,
  };
}

export async function main(): Promise<void> {
  process.exitCode = await run(process.argv.slice(2), createDefaultDeps());
}

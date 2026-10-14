import { createProvider } from "../ai/registry.js";
import { PROVIDER_LABELS } from "../ai/base.js";
import { runGit } from "../git/exec.js";
import { assertCommittable, branchName, findRepoRoot, inspectRepo } from "../git/repo.js";
import { loadConfig, type ConfigLocation } from "../config/config.js";
import {
  findApiKey,
  normalizeOllamaHost,
  resolveJira,
  resolveLimits,
  resolveProviderChoice,
} from "../config/settings.js";
import type { SecretStore } from "../credentials/store.js";
import { JiraClient, JiraError } from "../jira/client.js";
import { CheckinError, errorMessage } from "../util/errors.js";
import type { FetchLike, Sleep } from "../util/http.js";
import type { Io } from "../util/io.js";
import { secretVariants } from "../util/redact.js";
import { resolveGitleaksCommand, resolveScanMode, runCommand } from "../scan/gitleaks.js";

export interface DoctorDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  io: Io;
  secrets: SecretStore;
  configLocation: ConfigLocation;
  fetch: FetchLike;
  sleep: Sleep;
}

type Status = "ok" | "warn" | "fail";
interface Finding {
  status: Status;
  label: string;
  detail?: string;
}

const ICON: Record<Status, string> = { ok: "✔", warn: "!", fail: "✖" };

const MIN_NODE_MAJOR = 20;

function fail(label: string, e: unknown): Finding {
  const hint = e instanceof CheckinError && e.hint ? ` — ${e.hint}` : "";
  return { status: "fail", label, detail: `${errorMessage(e)}${hint}` };
}

/** Diagnose configuration and connectivity. Sends no repository content. Returns true when nothing failed. */
export async function runDoctor(deps: DoctorDeps): Promise<boolean> {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  const { io } = deps;

  // Runtime
  const major = Number(process.versions.node.split(".")[0]);
  add(major >= MIN_NODE_MAJOR
    ? { status: "ok", label: `Node.js ${process.versions.node}` }
    : { status: "fail", label: `Node.js ${process.versions.node}`, detail: `Node ${MIN_NODE_MAJOR}+ is required.` });

  // Git
  try {
    const v = await runGit(["--version"], { cwd: deps.cwd });
    add({ status: "ok", label: v.stdout.trim() });
  } catch (e) {
    add(fail("git", e));
  }

  // Secret scanning
  try {
    const mode = resolveScanMode(deps.env);
    if (mode === "off") {
      add({ status: "warn", label: "Secret scanning is off (CHECKIN_SECRET_SCAN=off)", detail: "Staged changes are not checked for passwords or keys." });
    } else {
      const { command, source } = resolveGitleaksCommand(deps.env);
      let version: string | null = null;
      try {
        const r = await runCommand(command, ["version"], { cwd: deps.cwd, timeoutMs: 15_000 });
        if (r !== null && r.code === 0) version = r.stdout.trim().split(/\r?\n/)[0] ?? "";
      } catch {
        version = null;
      }
      add(version !== null
        ? { status: "ok", label: `Secret scanning: gitleaks ${version} (${source === "bundled" ? "installed with checkin" : source === "PATH" ? "from your PATH" : "from CHECKIN_GITLEAKS_PATH"}; mode: ${mode})` }
        : {
            status: mode === "required" ? "fail" : "warn",
            label: "gitleaks was not found or did not run",
            detail: `Staged changes will ${mode === "required" ? "be refused" : "NOT be scanned for secrets"}. Run \`npm run install-gitleaks\` in the checkin package, or install it yourself (e.g. \`brew install gitleaks\`).`,
          });
    }
  } catch (e) {
    add(fail("Secret scanning", e));
  }

  // Repository (informational: doctor works anywhere)
  try {
    const root = await findRepoRoot(deps.cwd);
    const state = await inspectRepo(root);
    try {
      assertCommittable(state);
      add({ status: "ok", label: `Repository ${root}`, detail: `branch ${branchName(state.branchRef)}${state.head === null ? " (no commits yet)" : ""}` });
    } catch (e) {
      add({ status: "warn", label: `Repository ${root}`, detail: errorMessage(e).split("\n")[0] ?? "" });
    }
    const name = await runGit(["config", "user.name"], { cwd: root });
    const email = await runGit(["config", "user.email"], { cwd: root });
    add(name.stdout.trim() && email.stdout.trim()
      ? { status: "ok", label: "Git identity (user.name / user.email) is set" }
      : { status: "fail", label: "Git identity is not set", detail: "git commit will fail. Run `git config user.name` and `git config user.email`." });
  } catch {
    add({ status: "warn", label: "Not inside a Git repository", detail: "Repository checks skipped." });
  }

  // Configuration
  let config;
  try {
    config = await loadConfig(deps.configLocation);
    add({ status: "ok", label: `Config ${deps.configLocation.file}`, detail: config.provider || config.jira ? undefined : "no settings saved yet" });
  } catch (e) {
    add(fail("Config", e));
    return finish(io, findings);
  }
  let limits;
  try {
    limits = resolveLimits(config, deps.env);
    add({ status: "ok", label: `Limits: diff ≤ ${limits.maxDiffBytes} bytes, timeout ${Math.round(limits.timeoutMs / 1000)}s, ${limits.maxAttempts} attempts` });
  } catch (e) {
    add(fail("Limits", e));
    return finish(io, findings);
  }

  // Credential store
  const store = await deps.secrets.check();
  add(store.ok
    ? { status: "ok", label: `Credential store: ${deps.secrets.name}` }
    : { status: "warn", label: `Credential store unavailable: ${deps.secrets.name}`, detail: `${store.reason}. Use environment variables for credentials.` });

  // Provider
  try {
    const choice = resolveProviderChoice(config, deps.env);
    if (choice === null) {
      add({ status: "fail", label: "AI provider", detail: "not configured — run `checkin setup`." });
    } else {
      add({ status: "ok", label: `Provider ${PROVIDER_LABELS[choice.provider]}, model ${choice.model}` });
      const host = choice.provider === "ollama" ? normalizeOllamaHost(deps.env.OLLAMA_HOST ?? config.ollamaHost) : undefined;
      const found = await findApiKey(choice.provider, deps.env, deps.secrets);
      if (choice.provider !== "ollama") {
        if (found.key === null) {
          add({ status: "fail", label: "API key", detail: found.storeError ? `credential store error: ${found.storeError}` : "not found — run `checkin setup` or set the provider's API key variable." });
        } else {
          io.addSecrets(found.key);
          add({ status: "ok", label: `API key found (${found.source})` });
        }
      }
      if (choice.provider === "ollama" || found.key !== null) {
        try {
          const provider = createProvider(choice.provider, {
            model: choice.model,
            ...(found.key ? { apiKey: found.key } : {}),
            ...(host ? { host } : {}),
            timeoutMs: Math.min(limits.timeoutMs, 15_000),
            maxAttempts: 1,
            fetch: deps.fetch,
            sleep: deps.sleep,
          });
          await provider.ping();
          add({ status: "ok", label: `${PROVIDER_LABELS[choice.provider]} reachable; credentials and model accepted`, ...(host ? { detail: host } : {}) });
        } catch (e) {
          add(fail(`${PROVIDER_LABELS[choice.provider]} connectivity`, e));
        }
      }
    }
  } catch (e) {
    add(fail("AI provider", e));
  }

  // Jira
  try {
    const jira = await resolveJira(config, deps.env, deps.secrets);
    if (jira === null) {
      add({ status: "ok", label: "Jira: not configured (optional)" });
    } else {
      io.addSecrets(...secretVariants(jira.token, jira.email));
      add({ status: "ok", label: `Jira ${jira.siteUrl} (${jira.authType}); token from ${jira.tokenSource}` });
      try {
        const client = new JiraClient(jira, { fetch: deps.fetch, sleep: deps.sleep, timeoutMs: Math.min(limits.timeoutMs, 15_000), maxAttempts: 1 });
        const who = await client.ping();
        add({ status: "ok", label: "Jira reachable; credentials accepted", ...(who.account ? { detail: `signed in as ${who.account}` } : {}) });
      } catch (e) {
        if (e instanceof JiraError && e.kind === "forbidden") {
          add({ status: "warn", label: "Jira reachable, but the profile check was denied", detail: "Likely a token scope limitation; reading tickets may still work." });
        } else {
          add(fail("Jira connectivity", e));
        }
      }
    }
  } catch (e) {
    add(fail("Jira", e));
  }

  return finish(io, findings);
}

function finish(io: Io, findings: Finding[]): boolean {
  for (const f of findings) {
    io.out(`${ICON[f.status]} ${f.label}${f.detail ? `\n    ${f.detail}` : ""}`);
  }
  const failed = findings.filter((f) => f.status === "fail").length;
  const warned = findings.filter((f) => f.status === "warn").length;
  io.out(failed > 0 ? `\n${failed} problem${failed === 1 ? "" : "s"} found.` : warned > 0 ? "\nNo problems; some warnings above." : "\nAll checks passed.");
  return failed === 0;
}

import { MODEL_SUGGESTIONS, API_KEY_ENV, createProvider } from "../ai/registry.js";
import { listOllamaModels } from "../ai/ollama.js";
import { PROVIDER_IDS, type ProviderId } from "../ai/types.js";
import { PROVIDER_LABELS } from "../ai/base.js";
import { JIRA_AUTH_TYPES, loadConfig, saveConfig, type ConfigLocation, type JiraAuthType, type JiraConfig, type StoredConfig } from "../config/config.js";
import { normalizeOllamaHost, DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS, type ResolvedJira } from "../config/settings.js";
import { accounts, type SecretStore } from "../credentials/store.js";
import { JiraClient, JiraError } from "../jira/client.js";
import { normalizeSiteUrl } from "../jira/url.js";
import { CheckinError, errorMessage } from "../util/errors.js";
import type { FetchLike, Sleep } from "../util/http.js";
import type { Io } from "../util/io.js";
import { secretVariants } from "../util/redact.js";
import type { Prompter } from "./prompter.js";

export interface SetupDeps {
  env: Record<string, string | undefined>;
  io: Io;
  prompter: Prompter;
  secrets: SecretStore;
  configLocation: ConfigLocation;
  fetch: FetchLike;
  sleep: Sleep;
}

const OTHER = "__other__";
const nonEmpty = (label: string) => (v: string) => (v.trim() === "" ? `${label} is required` : undefined);

const JIRA_AUTH_LABELS: Record<JiraAuthType, { label: string; hint: string }> = {
  "api-token": { label: "API token", hint: "classic token from id.atlassian.com; used against your site URL" },
  "scoped-api-token": { label: "API token with scopes", hint: "needs read:jira-work; uses api.atlassian.com" },
  "service-account-token": { label: "Service account token", hint: "Bearer token; uses api.atlassian.com" },
};

interface PendingSecret {
  account: string;
  value: string;
}

/**
 * Interactive configuration. Everything is collected and (optionally) verified
 * first; secrets are written to the OS credential store and config.json is
 * written only at the end, so cancelling part-way saves nothing.
 */
export async function runSetup(deps: SetupDeps): Promise<void> {
  const { prompter: ui, io } = deps;
  const existing = await loadConfig(deps.configLocation);
  const config: StoredConfig = { ...existing, version: 1 };
  const pending: PendingSecret[] = [];
  const removals: string[] = [];

  ui.intro("checkin setup");

  const storeCheck = await deps.secrets.check();
  if (!storeCheck.ok) {
    ui.warn(
      `The ${deps.secrets.name} is not available (${storeCheck.reason}).\n` +
        "checkin will not write secrets to disk. Provide credentials through environment variables instead " +
        "(for example OPENAI_API_KEY and CHECKIN_JIRA_API_TOKEN). Non-secret settings can still be saved.",
    );
  }

  // ── AI provider ────────────────────────────────────────────────────────────
  const provider = await ui.select<ProviderId>(
    "Which AI provider do you want to use?",
    PROVIDER_IDS.map((id) => ({
      value: id,
      label: PROVIDER_LABELS[id],
      hint: id === "ollama" ? "local; nothing leaves your machine" : "your own API key",
    })),
    existing.provider,
  );
  config.provider = provider;
  let apiKey: string | undefined;

  if (provider === "ollama") {
    const host = normalizeOllamaHost(
      await ui.text("Ollama server address", { initial: deps.env.OLLAMA_HOST ?? existing.ollamaHost ?? "http://127.0.0.1:11434" }),
    );
    config.ollamaHost = host;
    let installed: string[] = [];
    try {
      installed = await listOllamaModels(host, deps.fetch);
    } catch (e) {
      ui.warn(`Could not list models from ${host} (${errorMessage(e)}). You can still type a model name.`);
    }
    config.model = await pickModel(ui, installed.map((m) => ({ value: m, label: m })), existing.provider === "ollama" ? existing.model : undefined, "Which installed model?");
  } else {
    delete config.ollamaHost;
    const suggestions = MODEL_SUGGESTIONS[provider];
    config.model = await pickModel(
      ui,
      [suggestions.default, ...suggestions.others].map((m, i) => ({ value: m, label: m, ...(i === 0 ? { hint: "default" } : {}) })),
      existing.provider === provider ? existing.model : suggestions.default,
      "Which model?",
    );

    const envName = API_KEY_ENV[provider].find((n) => deps.env[n]);
    if (envName) {
      ui.info(`${envName} is set in your environment and takes precedence over any stored key. Nothing will be stored.`);
    } else if (storeCheck.ok) {
      const alreadyStored = (await deps.secrets.get(accounts.apiKey(provider)).catch(() => null)) !== null;
      if (!alreadyStored || !(await ui.confirm(`A ${PROVIDER_LABELS[provider]} key is already stored. Keep it?`, true))) {
        apiKey = await ui.password(`${PROVIDER_LABELS[provider]} API key (input is hidden)`, nonEmpty("An API key"));
        io.addSecrets(apiKey);
        pending.push({ account: accounts.apiKey(provider), value: apiKey });
      }
    } else {
      ui.warn(`Set ${API_KEY_ENV[provider][0]} in your shell profile before running checkin.`);
    }
  }

  // Optional connectivity test. It sends no repository content.
  let effectiveKey = apiKey;
  if (provider !== "ollama" && effectiveKey === undefined) {
    effectiveKey = API_KEY_ENV[provider].map((n) => deps.env[n]).find(Boolean);
    if (effectiveKey === undefined && storeCheck.ok) {
      effectiveKey = (await deps.secrets.get(accounts.apiKey(provider)).catch(() => null)) ?? undefined;
    }
    if (effectiveKey) io.addSecrets(effectiveKey);
  }
  if (await ui.confirm("Test the connection and model now? (no repository content is sent)", true)) {
    try {
      const client = createProvider(provider, {
        model: config.model!,
        ...(effectiveKey ? { apiKey: effectiveKey } : {}),
        ...(config.ollamaHost ? { host: config.ollamaHost } : {}),
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        fetch: deps.fetch,
        sleep: deps.sleep,
      });
      await client.ping();
      ui.info(`Connected to ${PROVIDER_LABELS[provider]}; model "${config.model}" is available.`);
    } catch (e) {
      ui.warn(`The connection test failed: ${errorMessage(e)}${e instanceof CheckinError && e.hint ? `\n${e.hint}` : ""}\nYou can fix this later; settings will still be saved.`);
    }
  }

  // ── Jira (optional) ────────────────────────────────────────────────────────
  const jiraChoices = existing.jira
    ? [
        { value: "keep", label: "Keep the current Jira settings" },
        { value: "configure", label: "Reconfigure Jira" },
        { value: "disable", label: "Disable Jira" },
      ]
    : [
        { value: "skip", label: "No, skip Jira" },
        { value: "configure", label: "Yes, set up Jira Cloud" },
      ];
  const jiraAction = await ui.select<string>("Use Jira ticket context in commit messages?", jiraChoices, existing.jira ? "keep" : "skip");
  if (jiraAction === "disable") {
    delete config.jira;
    removals.push(accounts.jiraToken);
  } else if (jiraAction === "configure") {
    const { jira, token } = await configureJira(deps, existing.jira, storeCheck.ok);
    config.jira = jira;
    if (token !== undefined) pending.push({ account: accounts.jiraToken, value: token });
  }

  // ── Persist ───────────────────────────────────────────────────────────────
  for (const secret of pending) await deps.secrets.set(secret.account, secret.value);
  for (const account of removals) await deps.secrets.delete(account);
  await saveConfig(deps.configLocation, config);

  const lines = [
    `Saved settings to ${deps.configLocation.file}`,
    `Provider: ${PROVIDER_LABELS[provider]}, model: ${config.model}`,
    config.jira ? `Jira: ${config.jira.siteUrl} (${JIRA_AUTH_LABELS[config.jira.authType].label})` : "Jira: off",
  ];
  ui.outro(lines.join("\n"));
}

async function pickModel(
  ui: Prompter,
  options: Array<{ value: string; label: string; hint?: string }>,
  initial: string | undefined,
  message: string,
): Promise<string> {
  if (options.length === 0) {
    return ui.text("Model name", { validate: nonEmpty("A model name") });
  }
  const all = [...options, { value: OTHER, label: "Other (type a model name)" }];
  const known = initial !== undefined && options.some((o) => o.value === initial);
  const chosen = await ui.select<string>(message, all, known ? initial : options[0]?.value);
  if (chosen !== OTHER) return chosen;
  return ui.text("Model name", { ...(initial ? { initial } : {}), validate: nonEmpty("A model name") });
}

async function configureJira(
  deps: SetupDeps,
  existing: JiraConfig | undefined,
  storeAvailable: boolean,
): Promise<{ jira: JiraConfig; token?: string }> {
  const { prompter: ui, io } = deps;
  const authType = await ui.select<JiraAuthType>(
    "Which kind of Jira credential will you use?",
    JIRA_AUTH_TYPES.map((t) => ({ value: t, label: JIRA_AUTH_LABELS[t].label, hint: JIRA_AUTH_LABELS[t].hint })),
    existing?.authType ?? "api-token",
  );
  const siteInput = await ui.text("Jira Cloud site", {
    initial: existing?.siteUrl ?? "",
    placeholder: "your-company.atlassian.net",
    validate: (v) => {
      try {
        normalizeSiteUrl(v);
        return undefined;
      } catch (e) {
        return errorMessage(e);
      }
    },
  });
  const siteUrl = normalizeSiteUrl(siteInput);
  const jira: JiraConfig = { authType, siteUrl };

  if (authType !== "service-account-token") {
    jira.email = await ui.text("Atlassian account email", { initial: existing?.email ?? "", validate: nonEmpty("An email") });
  }

  const tokenFromEnv = deps.env.CHECKIN_JIRA_API_TOKEN;
  let token: string | undefined;
  if (tokenFromEnv) {
    ui.info("CHECKIN_JIRA_API_TOKEN is set in your environment and takes precedence. Nothing will be stored.");
  } else if (storeAvailable) {
    token = await ui.password("Jira API token (input is hidden)", nonEmpty("An API token"));
    io.addSecrets(...secretVariants(token, jira.email));
  } else {
    ui.warn("Set CHECKIN_JIRA_API_TOKEN in your shell profile before running checkin.");
  }
  const effectiveToken = token ?? tokenFromEnv;

  const probe = (cloudId?: string): JiraClient => {
    const settings: ResolvedJira = { authType, siteUrl, token: effectiveToken ?? "", tokenSource: "setup" };
    if (jira.email !== undefined) settings.email = jira.email;
    if (cloudId !== undefined) settings.cloudId = cloudId;
    return new JiraClient(settings, { fetch: deps.fetch, sleep: deps.sleep, timeoutMs: DEFAULT_TIMEOUT_MS, maxAttempts: DEFAULT_MAX_ATTEMPTS });
  };

  if (authType !== "api-token") {
    try {
      jira.cloudId = await probe().discoverCloudId();
    } catch (e) {
      ui.warn(`Could not look up the cloud id automatically (${errorMessage(e)}).`);
      jira.cloudId = await ui.text("Jira cloud id (from <site>/_edge/tenant_info)", { validate: nonEmpty("A cloud id") });
    }
  }

  if (effectiveToken && (await ui.confirm("Test the Jira credentials now?", true))) {
    try {
      const who = await probe(jira.cloudId).ping();
      ui.info(`Jira accepted the credentials${who.account ? ` (signed in as ${who.account})` : ""}.`);
    } catch (e) {
      if (e instanceof JiraError && e.kind === "forbidden") {
        ui.info("Jira accepted the credentials, but the token cannot read the account profile (a scope limitation). Reading tickets may still work.");
      } else {
        ui.warn(`The Jira test failed: ${errorMessage(e)}${e instanceof CheckinError && e.hint ? `\n${e.hint}` : ""}\nSettings will still be saved.`);
      }
    }
  }
  return token === undefined ? { jira } : { jira, token };
}

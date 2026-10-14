import { MODEL_SUGGESTIONS, API_KEY_ENV } from "../ai/registry.js";
import { DEFAULT_OLLAMA_HOST } from "../ai/ollama.js";
import { PROVIDER_IDS, type ProviderId } from "../ai/types.js";
import { accounts, type SecretStore } from "../credentials/store.js";
import { DEFAULT_MAX_DIFF_BYTES } from "../generate/generate.js";
import { normalizeSiteUrl } from "../jira/url.js";
import { CheckinError } from "../util/errors.js";
import { JIRA_AUTH_TYPES, type JiraAuthType, type StoredConfig } from "./config.js";

type Env = Record<string, string | undefined>;

export const DEFAULT_TIMEOUT_MS = 60_000;
/** One try plus two retries for transient failures. */
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface Limits {
  maxDiffBytes: number;
  timeoutMs: number;
  maxAttempts: number;
}

function envPositiveInt(env: Env, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new CheckinError(`${name} must be a positive integer (got "${raw}").`);
  return n;
}

export function resolveLimits(config: StoredConfig, env: Env): Limits {
  return {
    maxDiffBytes: envPositiveInt(env, "CHECKIN_MAX_DIFF_BYTES") ?? config.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES,
    timeoutMs: envPositiveInt(env, "CHECKIN_TIMEOUT_MS") ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
  };
}

/** OLLAMA_HOST is often written without a scheme ("127.0.0.1:11434", ":11434") or as 0.0.0.0. */
export function normalizeOllamaHost(raw: string | undefined): string {
  if (!raw) return DEFAULT_OLLAMA_HOST;
  let host = raw.trim();
  if (host.startsWith(":")) host = `127.0.0.1${host}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = `http://${host}`;
  return host.replace("//0.0.0.0", "//127.0.0.1").replace(/\/+$/, "");
}

export interface ResolvedProvider {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  host?: string;
  /** Where the key came from, for diagnostics. Never the key itself. */
  keySource?: string;
}

export function resolveProviderChoice(config: StoredConfig, env: Env): { provider: ProviderId; model: string } | null {
  const rawProvider = env.CHECKIN_PROVIDER ?? config.provider;
  if (rawProvider === undefined) return null;
  if (!(PROVIDER_IDS as readonly string[]).includes(rawProvider)) {
    throw new CheckinError(`Unknown provider "${rawProvider}".`, { hint: `Use one of: ${PROVIDER_IDS.join(", ")}.` });
  }
  const provider = rawProvider as ProviderId;
  const model = env.CHECKIN_MODEL ?? config.model ?? (provider === "ollama" ? undefined : MODEL_SUGGESTIONS[provider].default);
  if (model === undefined) {
    throw new CheckinError("No Ollama model is configured.", { hint: "Run `checkin setup` to pick an installed model, or set CHECKIN_MODEL." });
  }
  return { provider, model };
}

/** Where an API key came from: an environment variable, the OS credential store, or nowhere. */
export async function findApiKey(
  provider: ProviderId,
  env: Env,
  store: SecretStore,
): Promise<{ key: string; source: string } | { key: null; storeError?: string }> {
  if (provider === "ollama") return { key: null };
  for (const name of API_KEY_ENV[provider]) {
    const value = env[name];
    if (value) return { key: value, source: `environment variable ${name}` };
  }
  try {
    const stored = await store.get(accounts.apiKey(provider));
    if (stored) return { key: stored, source: store.name };
    return { key: null };
  } catch (e) {
    return { key: null, storeError: e instanceof Error ? e.message : String(e) };
  }
}

export async function resolveProvider(config: StoredConfig, env: Env, store: SecretStore): Promise<ResolvedProvider> {
  const choice = resolveProviderChoice(config, env);
  if (choice === null) {
    throw new CheckinError("No AI provider is configured.", { hint: "Run `checkin setup` (or set CHECKIN_PROVIDER and the provider's API key environment variable)." });
  }
  if (choice.provider === "ollama") {
    return { ...choice, host: normalizeOllamaHost(env.OLLAMA_HOST ?? config.ollamaHost) };
  }
  const found = await findApiKey(choice.provider, env, store);
  if (found.key === null) {
    const envName = API_KEY_ENV[choice.provider][0];
    throw new CheckinError(
      found.storeError
        ? `No API key in the environment, and the credential store could not be read: ${found.storeError}`
        : `No API key found for ${choice.provider}.`,
      { hint: `Run \`checkin setup\`, or set ${envName} in your environment.` },
    );
  }
  return { ...choice, apiKey: found.key, keySource: found.source };
}

export interface ResolvedJira {
  authType: JiraAuthType;
  siteUrl: string;
  email?: string;
  cloudId?: string;
  token: string;
  tokenSource: string;
}

/**
 * Jira is "configured" when config.json has a jira section or CHECKIN_JIRA_SITE_URL is set.
 * Deliberately not triggered by generic variables such as JIRA_API_TOKEN, so an
 * unrelated token in your shell never turns the integration on.
 */
export async function resolveJira(config: StoredConfig, env: Env, store: SecretStore): Promise<ResolvedJira | null> {
  if (config.jira === undefined && !env.CHECKIN_JIRA_SITE_URL) return null;

  const authType = (env.CHECKIN_JIRA_AUTH_TYPE ?? config.jira?.authType ?? "api-token") as JiraAuthType;
  if (!(JIRA_AUTH_TYPES as readonly string[]).includes(authType)) {
    throw new CheckinError(`Unknown Jira auth type "${authType}".`, { hint: `Use one of: ${JIRA_AUTH_TYPES.join(", ")}.` });
  }
  const rawSite = env.CHECKIN_JIRA_SITE_URL ?? config.jira?.siteUrl;
  if (!rawSite) throw new CheckinError("Jira is enabled but no site URL is set.", { hint: "Run `checkin setup`." });
  const siteUrl = normalizeSiteUrl(rawSite);
  const email = env.CHECKIN_JIRA_EMAIL ?? config.jira?.email;
  const cloudId = env.CHECKIN_JIRA_CLOUD_ID ?? config.jira?.cloudId;
  if (authType !== "service-account-token" && !email) {
    throw new CheckinError("Jira is enabled but no account email is set.", { hint: "Run `checkin setup`, or set CHECKIN_JIRA_EMAIL." });
  }

  let token = env.CHECKIN_JIRA_API_TOKEN;
  let tokenSource = "environment variable CHECKIN_JIRA_API_TOKEN";
  if (!token) {
    try {
      token = (await store.get(accounts.jiraToken)) ?? undefined;
      tokenSource = store.name;
    } catch (e) {
      throw new CheckinError(`Could not read the Jira token from the credential store: ${e instanceof Error ? e.message : String(e)}`, {
        hint: "Set CHECKIN_JIRA_API_TOKEN in your environment instead.",
      });
    }
  }
  if (!token) {
    throw new CheckinError("Jira is enabled but no API token was found.", {
      hint: "Run `checkin setup`, or set CHECKIN_JIRA_API_TOKEN. To turn Jira off, run `checkin setup` and choose to disable it.",
    });
  }
  const resolved: ResolvedJira = { authType, siteUrl, token, tokenSource };
  if (email !== undefined) resolved.email = email;
  if (cloudId !== undefined) resolved.cloudId = cloudId;
  return resolved;
}

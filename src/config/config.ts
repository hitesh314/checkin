import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PROVIDER_IDS, type ProviderId } from "../ai/types.js";
import { CheckinError } from "../util/errors.js";

export const JIRA_AUTH_TYPES = ["api-token", "scoped-api-token", "service-account-token"] as const;
export type JiraAuthType = (typeof JIRA_AUTH_TYPES)[number];

/** Non-secret Jira settings. The token itself is never stored here. */
export interface JiraConfig {
  authType: JiraAuthType;
  /** Origin of the Jira Cloud site, e.g. https://acme.atlassian.net */
  siteUrl: string;
  /** Account email (not used by service-account bearer tokens). */
  email?: string;
  /** Needed by scoped / service-account tokens, which go through api.atlassian.com. */
  cloudId?: string;
}

/** Everything persisted in config.json. No credentials, ever. */
export interface StoredConfig {
  version: 1;
  provider?: ProviderId;
  model?: string;
  ollamaHost?: string;
  maxDiffBytes?: number;
  timeoutMs?: number;
  jira?: JiraConfig;
}

export interface ConfigLocation {
  dir: string;
  file: string;
}

type Env = Record<string, string | undefined>;

/** `CHECKIN_CONFIG_DIR`, else `$XDG_CONFIG_HOME/checkin`, else `~/.config/checkin` (`%APPDATA%\checkin` on Windows). */
export function configLocation(env: Env = process.env, platform: NodeJS.Platform = process.platform): ConfigLocation {
  let dir: string;
  if (env.CHECKIN_CONFIG_DIR) dir = env.CHECKIN_CONFIG_DIR;
  else if (platform === "win32") dir = join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "checkin");
  else dir = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "checkin");
  return { dir, file: join(dir, "config.json") };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function optionalString(rec: Record<string, unknown>, key: string, where: string): string | undefined {
  const v = rec[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v === "") throw new Error(`"${where}${key}" must be a non-empty string`);
  return v;
}

function optionalPositiveInt(rec: Record<string, unknown>, key: string): number | undefined {
  const v = rec[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new Error(`"${key}" must be a positive integer`);
  return v;
}

export function validateConfig(data: unknown): StoredConfig {
  if (!isRecord(data)) throw new Error("the file must contain a JSON object");
  const config: StoredConfig = { version: 1 };

  const provider = optionalString(data, "provider", "");
  if (provider !== undefined) {
    if (!(PROVIDER_IDS as readonly string[]).includes(provider)) {
      throw new Error(`"provider" must be one of: ${PROVIDER_IDS.join(", ")}`);
    }
    config.provider = provider as ProviderId;
  }
  const model = optionalString(data, "model", "");
  if (model !== undefined) config.model = model;
  const ollamaHost = optionalString(data, "ollamaHost", "");
  if (ollamaHost !== undefined) config.ollamaHost = ollamaHost;
  const maxDiffBytes = optionalPositiveInt(data, "maxDiffBytes");
  if (maxDiffBytes !== undefined) config.maxDiffBytes = maxDiffBytes;
  const timeoutMs = optionalPositiveInt(data, "timeoutMs");
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;

  if (data.jira !== undefined) {
    if (!isRecord(data.jira)) throw new Error('"jira" must be an object');
    const j = data.jira;
    const authType = optionalString(j, "authType", "jira.") ?? "api-token";
    if (!(JIRA_AUTH_TYPES as readonly string[]).includes(authType)) {
      throw new Error(`"jira.authType" must be one of: ${JIRA_AUTH_TYPES.join(", ")}`);
    }
    const siteUrl = optionalString(j, "siteUrl", "jira.");
    if (siteUrl === undefined) throw new Error('"jira.siteUrl" is required');
    const jira: JiraConfig = { authType: authType as JiraAuthType, siteUrl };
    const email = optionalString(j, "email", "jira.");
    if (email !== undefined) jira.email = email;
    const cloudId = optionalString(j, "cloudId", "jira.");
    if (cloudId !== undefined) jira.cloudId = cloudId;
    config.jira = jira;
  }
  return config;
}

export async function loadConfig(location: ConfigLocation): Promise<StoredConfig> {
  let text: string;
  try {
    text = await readFile(location.file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
    throw new CheckinError(`Could not read ${location.file}: ${(e as Error).message}`);
  }
  try {
    return validateConfig(JSON.parse(text));
  } catch (e) {
    throw new CheckinError(`Invalid configuration in ${location.file}: ${(e as Error).message}`, {
      hint: "Fix or delete the file, or run `checkin setup` to recreate it.",
    });
  }
}

/** Atomic write with owner-only permissions (the file holds no secrets, but there is no reason to share it). */
export async function saveConfig(location: ConfigLocation, config: StoredConfig): Promise<void> {
  await mkdir(dirname(location.file), { recursive: true, mode: 0o700 });
  const tmp = `${location.file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, location.file);
}

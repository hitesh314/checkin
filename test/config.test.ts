import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configLocation, loadConfig, saveConfig, validateConfig } from "../src/config/config.js";
import { findApiKey, normalizeOllamaHost, resolveJira, resolveLimits, resolveProvider } from "../src/config/settings.js";
import { createMemoryStore } from "../src/credentials/store.js";
import { CheckinError } from "../src/util/errors.js";
import { rejection } from "./helpers/fakes.js";
import { makeTempDir } from "./helpers/repo.js";

describe("config location", () => {
  it("honours CHECKIN_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
    expect(configLocation({ CHECKIN_CONFIG_DIR: "/x" }, "linux")).toEqual({ dir: "/x", file: "/x/config.json" });
    expect(configLocation({ XDG_CONFIG_HOME: "/xdg" }, "linux").dir).toBe("/xdg/checkin");
    expect(configLocation({}, "darwin").dir).toMatch(/\.config\/checkin$/);
    expect(configLocation({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32").dir).toContain("checkin");
  });
});

describe("config file", () => {
  it("round-trips, creates the directory, and restricts permissions", async () => {
    const dir = join(makeTempDir(), "nested", "checkin");
    const location = { dir, file: join(dir, "config.json") };
    await saveConfig(location, { version: 1, provider: "anthropic", model: "claude-haiku-5-5", jira: { authType: "api-token", siteUrl: "https://a.atlassian.net", email: "a@b.c" } });

    expect(await loadConfig(location)).toEqual({
      version: 1,
      provider: "anthropic",
      model: "claude-haiku-5-5",
      jira: { authType: "api-token", siteUrl: "https://a.atlassian.net", email: "a@b.c" },
    });
    expect(statSync(location.file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["config.json"]); // no temp files left behind
  });

  it("returns an empty config when the file does not exist", async () => {
    const dir = makeTempDir();
    expect(await loadConfig({ dir, file: join(dir, "config.json") })).toEqual({ version: 1 });
  });

  it.each([
    ["not an object", "[]"],
    ["bad provider", '{"provider":"bing"}'],
    ["empty model", '{"model":""}'],
    ["bad limit", '{"maxDiffBytes":-5}'],
    ["jira without site", '{"jira":{"authType":"api-token"}}'],
    ["jira bad auth", '{"jira":{"siteUrl":"https://a.atlassian.net","authType":"password"}}'],
    ["invalid JSON", "{nope"],
  ])("rejects an invalid config (%s) with a pointer to the file", async (_name, text) => {
    const dir = makeTempDir();
    const file = join(dir, "config.json");
    await saveConfig({ dir, file }, { version: 1 });
    (await import("node:fs")).writeFileSync(file, text);
    const err = await rejection<CheckinError>(loadConfig({ dir, file }));
    expect(err).toBeInstanceOf(CheckinError);
    expect(err.message).toContain(file);
  });

  it("validateConfig ignores unknown keys instead of persisting them", () => {
    expect(validateConfig({ provider: "openai", apiKey: "sk-should-not-survive" })).toEqual({ version: 1, provider: "openai" });
  });
});

describe("provider and credential resolution", () => {
  it("prefers environment variables over the credential store over nothing", async () => {
    const store = createMemoryStore({ "openai-api-key": "sk-from-store-000000" });
    expect(await findApiKey("openai", { OPENAI_API_KEY: "sk-from-env-000000" }, store)).toEqual({ key: "sk-from-env-000000", source: "environment variable OPENAI_API_KEY" });
    expect(await findApiKey("openai", {}, store)).toEqual({ key: "sk-from-store-000000", source: "memory" });
    expect(await findApiKey("openai", {}, createMemoryStore())).toEqual({ key: null });
  });

  it("accepts GOOGLE_API_KEY as a fallback for Gemini", async () => {
    expect((await findApiKey("gemini", { GOOGLE_API_KEY: "g-000000" }, createMemoryStore())).key).toBe("g-000000");
    expect((await findApiKey("gemini", { GEMINI_API_KEY: "a-000000", GOOGLE_API_KEY: "g-000000" }, createMemoryStore())).key).toBe("a-000000");
  });

  it("lets CHECKIN_PROVIDER and CHECKIN_MODEL override the saved config", async () => {
    const r = await resolveProvider({ version: 1, provider: "openai", model: "saved" }, { CHECKIN_PROVIDER: "anthropic", CHECKIN_MODEL: "env-model", ANTHROPIC_API_KEY: "k-000000" }, createMemoryStore());
    expect(r).toMatchObject({ provider: "anthropic", model: "env-model", apiKey: "k-000000" });
  });

  it("falls back to a default model for hosted providers", async () => {
    const r = await resolveProvider({ version: 1, provider: "openai" }, { OPENAI_API_KEY: "k-000000" }, createMemoryStore());
    expect(r.model).toBe("gpt-6-luna");
  });

  it("needs no key for Ollama but needs a model, and normalises the host", async () => {
    await expect(resolveProvider({ version: 1, provider: "ollama" }, {}, createMemoryStore())).rejects.toThrow(/No Ollama model/);
    const r = await resolveProvider({ version: 1, provider: "ollama", model: "llama" }, { OLLAMA_HOST: "0.0.0.0:11434" }, createMemoryStore());
    expect(r).toMatchObject({ provider: "ollama", host: "http://127.0.0.1:11434" });
    expect(r.apiKey).toBeUndefined();
  });

  it("normalises assorted OLLAMA_HOST spellings", () => {
    expect(normalizeOllamaHost(undefined)).toBe("http://127.0.0.1:11434");
    expect(normalizeOllamaHost(":8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeOllamaHost("gpu-box:11434/")).toBe("http://gpu-box:11434");
    expect(normalizeOllamaHost("https://ollama.internal")).toBe("https://ollama.internal");
  });

  it("explains how to proceed when no key exists", async () => {
    const err = await rejection<CheckinError>(resolveProvider({ version: 1, provider: "openai" }, {}, createMemoryStore()));
    expect(err.message).toContain("No API key found");
    expect(err.hint).toContain("OPENAI_API_KEY");
  });

  it("falls back to environment-variable guidance when the credential store is unavailable", async () => {
    const err = await rejection<CheckinError>(resolveProvider({ version: 1, provider: "openai" }, {}, createMemoryStore({}, false)));
    expect(err.message).toMatch(/credential store could not be read/);
    expect(err.hint).toContain("OPENAI_API_KEY");
    // …and an environment variable still works with a broken store.
    const ok = await resolveProvider({ version: 1, provider: "openai" }, { OPENAI_API_KEY: "k-000000" }, createMemoryStore({}, false));
    expect(ok.apiKey).toBe("k-000000");
  });

  it("rejects an unknown provider name", async () => {
    await expect(resolveProvider({ version: 1 }, { CHECKIN_PROVIDER: "bard" }, createMemoryStore())).rejects.toThrow(/Unknown provider/);
  });

  it("resolves numeric limits from env, config, then defaults, and rejects junk", () => {
    expect(resolveLimits({ version: 1 }, {})).toEqual({ maxDiffBytes: 100_000, timeoutMs: 60_000, maxAttempts: 3 });
    expect(resolveLimits({ version: 1, maxDiffBytes: 5 }, {}).maxDiffBytes).toBe(5);
    expect(resolveLimits({ version: 1, maxDiffBytes: 5 }, { CHECKIN_MAX_DIFF_BYTES: "9" }).maxDiffBytes).toBe(9);
    expect(() => resolveLimits({ version: 1 }, { CHECKIN_MAX_DIFF_BYTES: "lots" })).toThrow(/positive integer/);
    expect(() => resolveLimits({ version: 1 }, { CHECKIN_TIMEOUT_MS: "-1" })).toThrow(/positive integer/);
  });
});

describe("Jira resolution", () => {
  const jira = { authType: "api-token" as const, siteUrl: "https://a.atlassian.net", email: "a@b.c" };

  it("is off unless configured", async () => {
    expect(await resolveJira({ version: 1 }, {}, createMemoryStore())).toBeNull();
    expect(await resolveJira({ version: 1 }, { JIRA_API_TOKEN: "x", JIRA_BASE_URL: "https://a.atlassian.net" }, createMemoryStore())).toBeNull();
  });

  it("reads the token from the credential store", async () => {
    const r = await resolveJira({ version: 1, jira }, {}, createMemoryStore({ "jira-api-token": "tok-000000" }));
    expect(r).toMatchObject({ siteUrl: "https://a.atlassian.net", email: "a@b.c", token: "tok-000000", tokenSource: "memory" });
  });

  it("lets CHECKIN_JIRA_* variables supply or override everything", async () => {
    const r = await resolveJira(
      { version: 1 },
      { CHECKIN_JIRA_SITE_URL: "acme.atlassian.net", CHECKIN_JIRA_EMAIL: "e@x.y", CHECKIN_JIRA_API_TOKEN: "tok-000000", CHECKIN_JIRA_AUTH_TYPE: "scoped-api-token", CHECKIN_JIRA_CLOUD_ID: "cid" },
      createMemoryStore(),
    );
    expect(r).toEqual({ authType: "scoped-api-token", siteUrl: "https://acme.atlassian.net", email: "e@x.y", cloudId: "cid", token: "tok-000000", tokenSource: "environment variable CHECKIN_JIRA_API_TOKEN" });
  });

  it("requires an email except for service-account tokens", async () => {
    const env = { CHECKIN_JIRA_SITE_URL: "acme.atlassian.net", CHECKIN_JIRA_API_TOKEN: "tok-000000" };
    await expect(resolveJira({ version: 1 }, env, createMemoryStore())).rejects.toThrow(/no account email/);
    expect(await resolveJira({ version: 1 }, { ...env, CHECKIN_JIRA_AUTH_TYPE: "service-account-token" }, createMemoryStore())).toMatchObject({ authType: "service-account-token" });
  });

  it("explains a missing token, including how to turn Jira off", async () => {
    const err = await rejection<CheckinError>(resolveJira({ version: 1, jira }, {}, createMemoryStore()));
    expect(err.message).toContain("no API token");
    expect(err.hint).toContain("CHECKIN_JIRA_API_TOKEN");
    expect(err.hint).toContain("disable");
  });

  it("rejects a clear-text site URL", async () => {
    await expect(resolveJira({ version: 1 }, { CHECKIN_JIRA_SITE_URL: "http://a.atlassian.net", CHECKIN_JIRA_API_TOKEN: "t", CHECKIN_JIRA_EMAIL: "a@b.c" }, createMemoryStore())).rejects.toThrow(/https/);
  });

  it("points to environment variables when the store cannot be read", async () => {
    const err = await rejection<CheckinError>(resolveJira({ version: 1, jira }, {}, createMemoryStore({}, false)));
    expect(err.message).toMatch(/Could not read the Jira token/);
    expect(err.hint).toContain("CHECKIN_JIRA_API_TOKEN");
  });
});

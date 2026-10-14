import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Choice, Prompter } from "../src/commands/prompter.js";
import { runSetup, type SetupDeps } from "../src/commands/setup.js";
import { loadConfig } from "../src/config/config.js";
import { createMemoryStore, type SecretStore } from "../src/credentials/store.js";
import { CheckinError } from "../src/util/errors.js";
import { createBufferIo } from "../src/util/io.js";
import { jsonResponse, mockFetch } from "./helpers/fakes.js";
import { makeTempDir } from "./helpers/repo.js";

type Answer = string | boolean;

/** Scripted prompter: answers come from a queue and every question is recorded. */
class ScriptedPrompter implements Prompter {
  readonly asked: Array<{ kind: string; message: string; masked?: boolean }> = [];
  readonly notes: string[] = [];
  constructor(private readonly answers: Answer[]) {}
  private next(kind: string, message: string, masked = false): Answer {
    this.asked.push({ kind, message, masked });
    if (this.answers.length === 0) throw new Error(`unscripted prompt: ${kind} "${message}"`);
    return this.answers.shift()!;
  }
  intro() {}
  outro(m: string) {
    this.notes.push(m);
  }
  info(m: string) {
    this.notes.push(m);
  }
  warn(m: string) {
    this.notes.push(m);
  }
  async select<T extends string>(message: string, _choices: Choice<T>[]): Promise<T> {
    return this.next("select", message) as T;
  }
  async text(message: string): Promise<string> {
    return this.next("text", message) as string;
  }
  async password(message: string): Promise<string> {
    return this.next("password", message, true) as string;
  }
  async confirm(message: string): Promise<boolean> {
    return this.next("confirm", message) as boolean;
  }
}

const OPENAI_KEY = "sk-setup-0123456789abcdefABCDEF";
const JIRA_TOKEN = "ATATT3xFfGF0-jira-secret-value-0987654321";

function makeDeps(answers: Answer[], options: { store?: SecretStore; env?: Record<string, string>; fetch?: typeof fetch } = {}) {
  const dir = makeTempDir("checkin-setup-");
  const io = createBufferIo();
  const prompter = new ScriptedPrompter(answers);
  const store = options.store ?? createMemoryStore();
  const fetched = mockFetch(jsonResponse({ id: "ok", models: [{ name: "llama3.1:latest" }, { name: "qwen3:8b" }], displayName: "Dev", cloudId: "cloud-1" }));
  const deps: SetupDeps = {
    env: options.env ?? {},
    io,
    prompter,
    secrets: store,
    configLocation: { dir, file: join(dir, "config.json") },
    fetch: options.fetch ?? fetched.fetch,
    sleep: async () => {},
  };
  return { deps, io, prompter, store, dir, fetched };
}

describe("checkin setup", () => {
  it("stores the API key in the credential store (masked prompt) and keeps it out of config.json", async () => {
    // provider, model, key, test connection?, jira
    const t = makeDeps(["openai", "gpt-6-luna", OPENAI_KEY, true, "skip"]);

    await runSetup(t.deps);

    expect((t.store as ReturnType<typeof createMemoryStore>).data.get("openai-api-key")).toBe(OPENAI_KEY);
    const keyPrompt = t.prompter.asked.find((a) => a.message.includes("API key"))!;
    expect(keyPrompt.kind).toBe("password");
    expect(keyPrompt.masked).toBe(true);

    expect(await loadConfig(t.deps.configLocation)).toEqual({ version: 1, provider: "openai", model: "gpt-6-luna" });
    const everything = readdirSync(t.dir).map((f) => readFileSync(join(t.dir, f), "utf8")).join("\n");
    expect(everything).not.toContain(OPENAI_KEY);
    expect(everything).not.toContain("sk-setup");
    expect(t.io.text() + t.prompter.notes.join("\n")).not.toContain(OPENAI_KEY);
    // the connection test verified the key + model without sending repository content
    expect(t.fetched.calls[0]!.url).toBe("https://api.openai.com/v1/models/gpt-6-luna");
  });

  it("lets you type a model that is not in the suggestions", async () => {
    const t = makeDeps(["anthropic", "__other__", "claude-future-9", OPENAI_KEY, false, "skip"]);
    await runSetup(t.deps);
    expect((await loadConfig(t.deps.configLocation)).model).toBe("claude-future-9");
  });

  it("does not write secrets anywhere when the credential store is unavailable, and says so", async () => {
    const t = makeDeps(["openai", "gpt-6-luna", false, "skip"], { store: createMemoryStore({}, false) });

    await runSetup(t.deps);

    expect(t.prompter.notes.join("\n")).toMatch(/will not write secrets to disk/);
    expect(t.prompter.notes.join("\n")).toContain("OPENAI_API_KEY");
    expect(t.prompter.asked.some((a) => a.kind === "password")).toBe(false); // never even asks for a key it cannot store safely
    expect(readdirSync(t.dir)).toEqual(["config.json"]);
    expect(await loadConfig(t.deps.configLocation)).toMatchObject({ provider: "openai" });
  });

  it("does not ask for a key when one is already provided by the environment", async () => {
    const t = makeDeps(["openai", "gpt-6-luna", false, "skip"], { env: { OPENAI_API_KEY: OPENAI_KEY } });
    await runSetup(t.deps);
    expect(t.prompter.asked.some((a) => a.kind === "password")).toBe(false);
    expect((t.store as ReturnType<typeof createMemoryStore>).data.size).toBe(0);
  });

  it("keeps an existing stored key when asked to", async () => {
    const store = createMemoryStore({ "openai-api-key": OPENAI_KEY });
    const t = makeDeps(["openai", "gpt-6-luna", true, false, "skip"], { store });
    await runSetup(t.deps);
    expect(store.data.get("openai-api-key")).toBe(OPENAI_KEY);
    expect(t.prompter.asked.some((a) => a.kind === "password")).toBe(false);
  });

  it("offers installed Ollama models and needs no key", async () => {
    const t = makeDeps(["ollama", "http://127.0.0.1:11434", "qwen3:8b", true, "skip"]);
    await runSetup(t.deps);
    expect(await loadConfig(t.deps.configLocation)).toEqual({ version: 1, provider: "ollama", model: "qwen3:8b", ollamaHost: "http://127.0.0.1:11434" });
    expect(t.prompter.asked.some((a) => a.kind === "password")).toBe(false);
    expect(t.fetched.calls.map((c) => c.url)).toEqual(["http://127.0.0.1:11434/api/tags", "http://127.0.0.1:11434/api/tags"]);
  });

  it("falls back to typing a model name when Ollama cannot be reached", async () => {
    const t = makeDeps(["ollama", "http://127.0.0.1:11434", "my-model", false, "skip"], { fetch: mockFetch(new TypeError("fetch failed")).fetch });
    await runSetup(t.deps);
    expect((await loadConfig(t.deps.configLocation)).model).toBe("my-model");
    expect(t.prompter.notes.join("\n")).toMatch(/Could not list models/);
  });

  it("saves settings even when the connection test fails, and reports the failure", async () => {
    const t = makeDeps(["openai", "gpt-6-luna", OPENAI_KEY, true, "skip"], { fetch: mockFetch(jsonResponse({ error: { message: `bad key ${OPENAI_KEY}` } }, 401)).fetch });
    await runSetup(t.deps);
    const notes = t.prompter.notes.join("\n");
    expect(notes).toMatch(/connection test failed/);
    expect(notes).not.toContain(OPENAI_KEY);
    expect(await loadConfig(t.deps.configLocation)).toMatchObject({ provider: "openai" });
  });

  it("saves nothing when cancelled part-way", async () => {
    const t = makeDeps(["openai", "gpt-6-luna"]); // runs out of scripted answers: simulates Ctrl+C at the key prompt
    await expect(runSetup(t.deps)).rejects.toThrow(/unscripted prompt/);
    expect((t.store as ReturnType<typeof createMemoryStore>).data.size).toBe(0);
    expect(readdirSync(t.dir)).toEqual([]);
  });

  describe("Jira", () => {
    it("configures a classic API token: token to the credential store, only non-secrets to config.json", async () => {
      // provider flow (no key stored: env), then jira
      const t = makeDeps(["openai", "gpt-6-luna", false, "configure", "api-token", "acme.atlassian.net", "dev@acme.com", JIRA_TOKEN, true], { env: { OPENAI_API_KEY: OPENAI_KEY } });

      await runSetup(t.deps);

      expect((t.store as ReturnType<typeof createMemoryStore>).data.get("jira-api-token")).toBe(JIRA_TOKEN);
      expect((await loadConfig(t.deps.configLocation)).jira).toEqual({ authType: "api-token", siteUrl: "https://acme.atlassian.net", email: "dev@acme.com" });
      const file = readFileSync(t.deps.configLocation.file, "utf8");
      expect(file).not.toContain(JIRA_TOKEN);
      expect(t.prompter.asked.find((a) => a.message.includes("Jira API token"))!.masked).toBe(true);
      expect(t.prompter.notes.join("\n")).not.toContain(JIRA_TOKEN);
      const jiraCall = t.fetched.calls.find((c) => c.url.includes("/myself"))!;
      expect(jiraCall.url).toBe("https://acme.atlassian.net/rest/api/3/myself");
    });

    it("discovers and stores the cloud id for scoped tokens", async () => {
      const t = makeDeps(["openai", "gpt-6-luna", false, "configure", "scoped-api-token", "https://acme.atlassian.net", "dev@acme.com", JIRA_TOKEN, false], { env: { OPENAI_API_KEY: OPENAI_KEY } });
      await runSetup(t.deps);
      expect((await loadConfig(t.deps.configLocation)).jira).toEqual({ authType: "scoped-api-token", siteUrl: "https://acme.atlassian.net", email: "dev@acme.com", cloudId: "cloud-1" });
    });

    it("needs no email for a service-account token", async () => {
      const t = makeDeps(["openai", "gpt-6-luna", false, "configure", "service-account-token", "acme.atlassian.net", JIRA_TOKEN, false], { env: { OPENAI_API_KEY: OPENAI_KEY } });
      await runSetup(t.deps);
      const jira = (await loadConfig(t.deps.configLocation)).jira!;
      expect(jira.authType).toBe("service-account-token");
      expect(jira.email).toBeUndefined();
    });

    it("can disable Jira and removes the stored token", async () => {
      const store = createMemoryStore({ "jira-api-token": JIRA_TOKEN });
      const t = makeDeps(["openai", "gpt-6-luna", false, "disable"], { store, env: { OPENAI_API_KEY: OPENAI_KEY } });
      (await import("node:fs")).mkdirSync(t.dir, { recursive: true });
      const { saveConfig } = await import("../src/config/config.js");
      await saveConfig(t.deps.configLocation, { version: 1, provider: "openai", jira: { authType: "api-token", siteUrl: "https://acme.atlassian.net", email: "a@b.c" } });

      await runSetup(t.deps);

      expect((await loadConfig(t.deps.configLocation)).jira).toBeUndefined();
      expect(store.data.has("jira-api-token")).toBe(false);
    });

    it("does not store a Jira token when the credential store is unavailable", async () => {
      const t = makeDeps(["openai", "gpt-6-luna", false, "configure", "api-token", "acme.atlassian.net", "dev@acme.com"], { store: createMemoryStore({}, false), env: { OPENAI_API_KEY: OPENAI_KEY } });
      await runSetup(t.deps);
      expect(t.prompter.asked.some((a) => a.message.includes("Jira API token"))).toBe(false);
      expect(t.prompter.notes.join("\n")).toContain("CHECKIN_JIRA_API_TOKEN");
      expect(readdirSync(t.dir)).toEqual(["config.json"]);
    });

    it("accepts a token with limited scope (403 on /myself) without alarm", async () => {
      const t = makeDeps(["openai", "gpt-6-luna", false, "configure", "api-token", "acme.atlassian.net", "dev@acme.com", JIRA_TOKEN, true], {
        env: { OPENAI_API_KEY: OPENAI_KEY },
        fetch: mockFetch(jsonResponse({}, 403)).fetch,
      });
      await runSetup(t.deps);
      expect(t.prompter.notes.join("\n")).toMatch(/scope limitation/);
    });
  });
});

describe("error type", () => {
  it("setup failures are CheckinErrors the CLI can render", () => {
    expect(new CheckinError("x")).toBeInstanceOf(Error);
  });
});

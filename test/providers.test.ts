import { describe, expect, it } from "vitest";
import { createProvider } from "../src/ai/registry.js";
import { ollamaContextWindow } from "../src/ai/ollama.js";
import { AiProviderError, type GenerationRequest, type ProviderId } from "../src/ai/types.js";
import { COMMIT_SCHEMA } from "../src/generate/schema.js";
import { hang, jsonResponse, mockFetch, rejection } from "./helpers/fakes.js";

const KEY = "sk-live-SECRETSECRETSECRET1234567890";
const REQUEST: GenerationRequest = { system: "SYS", user: "USER", schema: COMMIT_SCHEMA, maxOutputTokens: 777 };
const REPLY = '{"subject":"feat: add x","body":""}';

function make(id: ProviderId, fetchImpl: typeof fetch, extra: { timeoutMs?: number; maxAttempts?: number; sleeps?: number[] } = {}) {
  return createProvider(id, {
    model: "test-model",
    apiKey: id === "ollama" ? undefined! : KEY,
    host: "http://ollama.test:11434",
    timeoutMs: extra.timeoutMs ?? 5000,
    maxAttempts: extra.maxAttempts ?? 3,
    fetch: fetchImpl,
    sleep: async (ms) => void extra.sleeps?.push(ms),
  });
}

const openaiOk = () => jsonResponse({ status: "completed", output: [{ type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text: REPLY }] }] });
const anthropicOk = () => jsonResponse({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: REPLY }] });
const geminiOk = () => jsonResponse({ status: "completed", steps: [{ type: "thought" }, { type: "model_output", content: [{ type: "text", text: REPLY }] }] });
const ollamaOk = () => jsonResponse({ done: true, done_reason: "stop", message: { role: "assistant", content: REPLY } });

describe("OpenAI adapter", () => {
  it("calls the Responses API with strict structured output and no server-side storage", async () => {
    const { fetch, calls } = mockFetch(openaiOk());
    expect(await make("openai", fetch).generate(REQUEST)).toBe(REPLY);

    const call = calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/responses");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.body).toMatchObject({
      model: "test-model",
      max_output_tokens: 777,
      store: false,
      input: [
        { role: "system", content: "SYS" },
        { role: "user", content: "USER" },
      ],
      text: { format: { type: "json_schema", name: "commit_message", strict: true, schema: COMMIT_SCHEMA } },
    });
  });

  it("reports refusals and incomplete replies distinctly", async () => {
    const refusal = mockFetch(jsonResponse({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }));
    await expect(make("openai", refusal.fetch).generate(REQUEST)).rejects.toMatchObject({ kind: "refusal" });

    const incomplete = mockFetch(jsonResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }));
    await expect(make("openai", incomplete.fetch).generate(REQUEST)).rejects.toMatchObject({ kind: "incomplete" });
  });

  it("pings by fetching the model", async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ id: "test-model" }));
    await make("openai", fetch).ping();
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/models/test-model");
    expect(calls[0]!.method).toBe("GET");
  });
});

describe("Anthropic adapter", () => {
  it("calls the Messages API with JSON outputs and ignores thinking blocks", async () => {
    const { fetch, calls } = mockFetch(anthropicOk());
    expect(await make("anthropic", fetch).generate(REQUEST)).toBe(REPLY);

    const call = calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe(KEY);
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toMatchObject({
      model: "test-model",
      max_tokens: 777,
      system: "SYS",
      messages: [{ role: "user", content: "USER" }],
      output_config: { format: { type: "json_schema", schema: COMMIT_SCHEMA } },
    });
  });

  it("maps refusal and max_tokens stop reasons", async () => {
    await expect(make("anthropic", mockFetch(jsonResponse({ stop_reason: "refusal", content: [] })).fetch).generate(REQUEST)).rejects.toMatchObject({ kind: "refusal" });
    await expect(make("anthropic", mockFetch(jsonResponse({ stop_reason: "max_tokens", content: [{ type: "text", text: "{" }] })).fetch).generate(REQUEST)).rejects.toMatchObject({ kind: "incomplete" });
  });
});

describe("Gemini adapter", () => {
  it("calls the Interactions API with store:false and a JSON response format", async () => {
    const { fetch, calls } = mockFetch(geminiOk());
    expect(await make("gemini", fetch).generate(REQUEST)).toBe(REPLY);

    const call = calls[0]!;
    expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(call.headers["x-goog-api-key"]).toBe(KEY);
    expect(call.url).not.toContain(KEY); // key travels in a header, never the URL
    expect(call.body).toMatchObject({
      model: "test-model",
      input: "USER",
      system_instruction: "SYS",
      store: false,
      generation_config: { max_output_tokens: 777 },
      response_format: { type: "text", mime_type: "application/json" },
    });
    const schema = (call.body as { response_format: { schema: Record<string, unknown> } }).response_format.schema;
    expect(schema.additionalProperties).toBeUndefined();
    expect(schema.required).toEqual(["subject", "body"]);
  });

  it("fails clearly when no model output is present", async () => {
    const { fetch } = mockFetch(jsonResponse({ status: "completed", steps: [{ type: "thought" }] }));
    await expect(make("gemini", fetch).generate(REQUEST)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("surfaces a non-completed interaction", async () => {
    const { fetch } = mockFetch(jsonResponse({ status: "failed", steps: [] }));
    await expect(make("gemini", fetch).generate(REQUEST)).rejects.toMatchObject({ kind: "server" });
  });
});

describe("Ollama adapter", () => {
  it("calls /api/chat locally with a schema, no streaming, and an explicitly sized context window", async () => {
    const { fetch, calls } = mockFetch(ollamaOk());
    expect(await make("ollama", fetch).generate(REQUEST)).toBe(REPLY);

    const call = calls[0]!;
    expect(call.url).toBe("http://ollama.test:11434/api/chat");
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toMatchObject({
      model: "test-model",
      stream: false,
      format: COMMIT_SCHEMA,
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "USER" },
      ],
      options: { temperature: 0, num_predict: 777, num_ctx: ollamaContextWindow(REQUEST) },
    });
  });

  it("sizes the context window from the prompt so long diffs are not silently cut off by Ollama's default", () => {
    expect(ollamaContextWindow(REQUEST)).toBe(8192);
    const big = { ...REQUEST, user: "x".repeat(100_000) };
    expect(ollamaContextWindow(big)).toBeGreaterThan(100_000 / 2.5);
    expect(ollamaContextWindow(big) % 1024).toBe(0);
  });

  it("pings via /api/tags and reports a missing model", async () => {
    const present = mockFetch(jsonResponse({ models: [{ name: "test-model:latest" }] }));
    await make("ollama", present.fetch).ping();
    const absent = mockFetch(jsonResponse({ models: [{ name: "other" }] }));
    await expect(make("ollama", absent.fetch).ping()).rejects.toMatchObject({ kind: "not_found" });
  });

  it("explains a connection failure", async () => {
    const { fetch } = mockFetch(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    const err = await rejection<AiProviderError>(make("ollama", fetch, { maxAttempts: 1 }).generate(REQUEST));
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.message).toContain("ECONNREFUSED");
    expect(err.hint).toContain("ollama serve");
  });

  it("flags a reply cut off by the output limit", async () => {
    const { fetch } = mockFetch(jsonResponse({ done: true, done_reason: "length", message: { content: '{"sub' } }));
    await expect(make("ollama", fetch).generate(REQUEST)).rejects.toMatchObject({ kind: "incomplete" });
  });
});

describe("HTTP errors, retries and timeouts", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
    [400, "bad_request"],
  ] as const)("does not retry a %i and classifies it as %s", async (status, kind) => {
    const { fetch, calls } = mockFetch(jsonResponse({ error: { message: "nope" } }, status));
    await expect(make("openai", fetch).generate(REQUEST)).rejects.toMatchObject({ kind });
    expect(calls).toHaveLength(1);
  });

  it("retries transient 5xx responses and then succeeds", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = mockFetch(jsonResponse({ error: { message: "overloaded" } }, 503), jsonResponse({}, 500), openaiOk());
    expect(await make("openai", fetch, { sleeps }).generate(REQUEST)).toBe(REPLY);
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]! - 250); // exponential backoff (jitter < 250ms)
  });

  it("honours Retry-After on 429", async () => {
    const sleeps: number[] = [];
    const { fetch } = mockFetch(jsonResponse({ error: { message: "slow down" } }, 429, { "retry-after": "2" }), anthropicOk());
    await make("anthropic", fetch, { sleeps }).generate(REQUEST);
    expect(sleeps).toEqual([2000]);
  });

  it("retries a network error", async () => {
    const { fetch, calls } = mockFetch(new TypeError("fetch failed"), geminiOk());
    await make("gemini", fetch).generate(REQUEST);
    expect(calls).toHaveLength(2);
  });

  it("stops after the bounded number of attempts and reports it", async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ error: { message: "still down" } }, 503));
    const err = await rejection<AiProviderError>(make("openai", fetch, { maxAttempts: 3 }).generate(REQUEST));
    expect(calls).toHaveLength(3);
    expect(err.kind).toBe("server");
    expect(err.message).toContain("after 3 attempts");
  });

  it("does not wait absurdly long on a huge Retry-After", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = mockFetch(jsonResponse({ error: { message: "quota" } }, 429, { "retry-after": "3600" }));
    const err = await rejection<AiProviderError>(make("openai", fetch, { sleeps }).generate(REQUEST));
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(err.kind).toBe("rate_limit");
  });

  it("times out a hung request, retries, and reports a timeout", async () => {
    const { fetch, calls } = mockFetch(hang);
    const err = await rejection<AiProviderError>(make("openai", fetch, { timeoutMs: 30, maxAttempts: 2 }).generate(REQUEST));
    expect(calls).toHaveLength(2);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.kind).toBe("timeout");
    expect(err.message).toContain("after 2 attempts");
  });

  it("recovers when a hung first attempt is followed by a good one", async () => {
    const { fetch, calls } = mockFetch(hang, openaiOk());
    expect(await make("openai", fetch, { timeoutMs: 30 }).generate(REQUEST)).toBe(REPLY);
    expect(calls).toHaveLength(2);
  });

  it("rejects an oversized response body", async () => {
    const { fetch } = mockFetch(new Response("x".repeat(1_100_000), { status: 200 }));
    await expect(make("openai", fetch).generate(REQUEST)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("rejects a non-JSON success body", async () => {
    const { fetch } = mockFetch(new Response("<html>proxy error</html>", { status: 200 }));
    await expect(make("openai", fetch).generate(REQUEST)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("redacts the API key if the server echoes it back in an error", async () => {
    const { fetch } = mockFetch(jsonResponse({ error: { message: `Incorrect API key provided: ${KEY}. Authorization: Bearer ${KEY}` } }, 401));
    const err = await rejection<AiProviderError>(make("openai", fetch).generate(REQUEST));
    expect(err.kind).toBe("auth");
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain("SECRETSECRET");
    expect(err.message).toContain("[REDACTED]");
  });

  it("redacts a key that appears in a network error detail", async () => {
    const { fetch } = mockFetch(new TypeError(`connect failed for https://u:${KEY}@proxy.example`));
    const err = await rejection<AiProviderError>(make("openai", fetch, { maxAttempts: 1 }).generate(REQUEST));
    expect(err.message).not.toContain("SECRETSECRET");
  });
});

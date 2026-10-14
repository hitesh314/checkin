import { HttpError, requestJson } from "../util/http.js";
import { AiProviderError, MAX_RESPONSE_BYTES, type AiFailureKind, type ProviderId, type ProviderOptions } from "./types.js";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  ollama: "Ollama",
};

export function keyEnvHint(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "Run `checkin setup`, or set OPENAI_API_KEY.";
    case "anthropic":
      return "Run `checkin setup`, or set ANTHROPIC_API_KEY.";
    case "gemini":
      return "Run `checkin setup`, or set GEMINI_API_KEY.";
    case "ollama":
      return "Check that Ollama is running (`ollama serve`) and the host is correct.";
  }
}

/** Shared plumbing for the four adapters: one place that maps HTTP failures to user-facing errors. */
export abstract class BaseProvider {
  abstract readonly id: ProviderId;

  constructor(protected readonly options: ProviderOptions) {}

  get model(): string {
    return this.options.model;
  }

  protected get label(): string {
    return PROVIDER_LABELS[this.id];
  }

  protected secrets(): string[] {
    return this.options.apiKey ? [this.options.apiKey] : [];
  }

  protected async call(method: "GET" | "POST", url: string, headers: Record<string, string>, body?: unknown): Promise<unknown> {
    try {
      const { body: parsed } = await requestJson({
        method,
        url,
        headers,
        ...(body === undefined ? {} : { body }),
        timeoutMs: this.options.timeoutMs,
        maxAttempts: this.options.maxAttempts,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        fetch: this.options.fetch,
        sleep: this.options.sleep,
        secrets: this.secrets(),
      });
      return parsed;
    } catch (e) {
      if (e instanceof HttpError) throw this.translate(e);
      throw e;
    }
  }

  protected fail(kind: AiFailureKind, message: string, hint?: string): AiProviderError {
    return new AiProviderError(this.id, kind, message, hint);
  }

  private translate(e: HttpError): AiProviderError {
    const tries = e.attempts > 1 ? ` after ${e.attempts} attempts` : "";
    switch (e.kind) {
      case "timeout":
        return this.fail("timeout", `${this.label} did not respond in time${tries} (${e.message}).`, "Try again, or raise the timeout with CHECKIN_TIMEOUT_MS.");
      case "network":
        return this.fail("network", `Could not reach ${this.label}${tries}: ${e.message}.`, this.id === "ollama" ? keyEnvHint("ollama") : "Check your network connection, proxy, and firewall.");
      case "too_large":
        return this.fail("invalid_response", `${this.label} returned an unexpectedly large response.`);
      case "invalid_json":
        return this.fail("invalid_response", `${this.label} returned a response that was not valid JSON.`);
      case "status":
        break;
    }
    const detail = e.message ? ` — ${e.message}` : "";
    switch (e.status) {
      case 401:
      case 403:
        return this.fail("auth", `${this.label} rejected the credentials (HTTP ${e.status})${detail}`, keyEnvHint(this.id));
      case 404:
        return this.fail("not_found", `${this.label} could not find model "${this.options.model}" (HTTP 404)${detail}`, "Check the model name with `checkin doctor`, or change it with `checkin setup`.");
      case 429:
        return this.fail("rate_limit", `${this.label} rate limit or quota reached (HTTP 429)${tries}${detail}`, "Wait a moment and retry, or check your plan and billing.");
      case 400:
      case 422:
        return this.fail("bad_request", `${this.label} rejected the request (HTTP ${e.status})${detail}`, "If the message mentions the model, change it with `checkin setup`.");
      default:
        return this.fail("server", `${this.label} returned HTTP ${e.status}${tries}${detail}`, "This is usually temporary; retry in a moment.");
    }
  }
}

/**
 * Gemini documents only a subset of JSON Schema for structured output;
 * `additionalProperties` is not in the examples, so it is dropped rather than
 * risking a 400. We validate the reply ourselves regardless.
 */
export function stripAdditionalProperties(schema: Record<string, unknown>): Record<string, unknown> {
  const { additionalProperties: _ignored, ...rest } = schema;
  return rest;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

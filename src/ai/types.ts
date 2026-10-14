import { CheckinError } from "../util/errors.js";
import type { FetchLike, Sleep } from "../util/http.js";

export const PROVIDER_IDS = ["openai", "anthropic", "gemini", "ollama"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type JsonSchema = Record<string, unknown>;

/** Provider-neutral request: what to say and what shape of JSON to get back. */
export interface GenerationRequest {
  system: string;
  user: string;
  /** JSON schema the reply must satisfy. Adapters pass it to the provider's structured-output feature. */
  schema: JsonSchema;
  maxOutputTokens: number;
}

/** Every adapter implements this. It returns the model's raw JSON text; validation happens elsewhere. */
export interface AiProvider {
  readonly id: ProviderId;
  readonly model: string;
  generate(request: GenerationRequest): Promise<string>;
  /**
   * Lightweight reachability/credential/model check used by `checkin doctor`.
   * Must not send any repository content. Throws AiProviderError on failure.
   */
  ping(): Promise<void>;
}

export interface ProviderOptions {
  model: string;
  /** Not used by Ollama. */
  apiKey?: string;
  /** Ollama server, e.g. http://127.0.0.1:11434. */
  host?: string;
  timeoutMs: number;
  /** Total attempts including the first. */
  maxAttempts: number;
  fetch: FetchLike;
  sleep: Sleep;
}

export type AiFailureKind =
  | "auth"
  | "not_found"
  | "bad_request"
  | "rate_limit"
  | "server"
  | "timeout"
  | "network"
  | "invalid_response"
  | "refusal"
  | "incomplete";

export class AiProviderError extends CheckinError {
  constructor(
    readonly provider: ProviderId,
    readonly kind: AiFailureKind,
    message: string,
    hint?: string,
  ) {
    super(message, hint === undefined ? {} : { hint });
  }
}

export const MAX_RESPONSE_BYTES = 1_000_000;

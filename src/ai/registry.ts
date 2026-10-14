import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAiProvider } from "./openai.js";
import type { AiProvider, ProviderId, ProviderOptions } from "./types.js";

export function createProvider(id: ProviderId, options: ProviderOptions): AiProvider {
  switch (id) {
    case "openai":
      return new OpenAiProvider(options);
    case "anthropic":
      return new AnthropicProvider(options);
    case "gemini":
      return new GeminiProvider(options);
    case "ollama":
      return new OllamaProvider(options);
  }
}

/**
 * Model names checked against each vendor's official model documentation on
 * 2026-10-14. These are only suggestions and defaults: the model is always
 * user-configurable (`checkin setup`, or CHECKIN_MODEL), because vendors
 * retire and add models regularly.
 */
export const MODEL_SUGGESTIONS: Record<Exclude<ProviderId, "ollama">, { default: string; others: string[] }> = {
  openai: { default: "gpt-6-luna", others: ["gpt-6.1-sol", "gpt-6-astra"] },
  anthropic: { default: "claude-haiku-5-5", others: ["claude-sonnet-5-5", "claude-opus-5-5"] },
  gemini: { default: "gemini-3.8-flash", others: ["gemini-3.5-flash-lite", "gemini-3.6-flash"] },
};

/** Environment variables that can supply each provider's API key, in priority order. */
export const API_KEY_ENV: Record<Exclude<ProviderId, "ollama">, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

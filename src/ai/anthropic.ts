import { asArray, asRecord, BaseProvider } from "./base.js";
import type { AiProvider, GenerationRequest } from "./types.js";

const BASE_URL = "https://api.anthropic.com/v1";
const API_VERSION = "2023-06-01";

/**
 * Anthropic via the Messages API (https://docs.anthropic.com/en/api/messages)
 * with JSON outputs (`output_config.format` = json_schema).
 */
export class AnthropicProvider extends BaseProvider implements AiProvider {
  readonly id = "anthropic" as const;

  private headers(): Record<string, string> {
    return {
      "x-api-key": this.options.apiKey ?? "",
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
    };
  }

  async generate(request: GenerationRequest): Promise<string> {
    const body = {
      model: this.options.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      output_config: { format: { type: "json_schema", schema: request.schema } },
    };
    const res = asRecord(await this.call("POST", `${BASE_URL}/messages`, this.headers(), body));
    if (!res) throw this.fail("invalid_response", "Anthropic returned an unexpected response shape.");

    if (res.stop_reason === "refusal") {
      throw this.fail("refusal", "Claude declined to generate a commit message for these changes.");
    }
    if (res.stop_reason === "max_tokens") {
      throw this.fail("incomplete", "Claude stopped before finishing the reply (max_tokens).", "Try again.");
    }

    // Skip thinking blocks; only text blocks carry the JSON.
    const texts: string[] = [];
    for (const block of asArray(res.content)) {
      const b = asRecord(block);
      if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
    }
    if (texts.length === 0) throw this.fail("invalid_response", "Anthropic returned no text output.");
    return texts.join("");
  }

  async ping(): Promise<void> {
    await this.call("GET", `${BASE_URL}/models/${encodeURIComponent(this.options.model)}`, this.headers());
  }
}

import { asArray, asRecord, BaseProvider, stripAdditionalProperties } from "./base.js";
import type { AiProvider, GenerationRequest } from "./types.js";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Google Gemini via the Interactions API (`POST /v1beta/interactions`), which
 * Google now recommends for new projects (https://ai.google.dev/gemini-api/docs/interactions-overview).
 * `store: false` is sent because Interactions stores requests by default.
 * The legacy `generateContent` API remains supported but is not used here.
 */
export class GeminiProvider extends BaseProvider implements AiProvider {
  readonly id = "gemini" as const;

  private headers(): Record<string, string> {
    return { "x-goog-api-key": this.options.apiKey ?? "", "Content-Type": "application/json" };
  }

  async generate(request: GenerationRequest): Promise<string> {
    const body = {
      model: this.options.model,
      input: request.user,
      system_instruction: request.system,
      store: false,
      response_format: { type: "text", mime_type: "application/json", schema: stripAdditionalProperties(request.schema) },
      generation_config: { max_output_tokens: request.maxOutputTokens },
    };
    const res = asRecord(await this.call("POST", `${BASE_URL}/interactions`, this.headers(), body));
    if (!res) throw this.fail("invalid_response", "Gemini returned an unexpected response shape.");

    const status = res.status;
    if (status !== undefined && status !== "completed") {
      throw this.fail(
        status === "incomplete" ? "incomplete" : "server",
        `Gemini did not complete the reply (status: ${typeof status === "string" ? status : "unknown"}).`,
        "Try again.",
      );
    }

    // Output lives in `model_output` steps; thought/tool steps are ignored.
    const texts: string[] = [];
    for (const step of asArray(res.steps)) {
      const s = asRecord(step);
      if (s?.type !== "model_output") continue;
      for (const part of asArray(s.content)) {
        const p = asRecord(part);
        if (p?.type === "text" && typeof p.text === "string") texts.push(p.text);
      }
    }
    if (texts.length === 0) throw this.fail("invalid_response", "Gemini returned no text output (the reply may have been blocked).");
    return texts.join("");
  }

  async ping(): Promise<void> {
    await this.call("GET", `${BASE_URL}/models/${encodeURIComponent(this.options.model)}`, this.headers());
  }
}

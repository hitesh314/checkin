import { asArray, asRecord, BaseProvider } from "./base.js";
import type { AiProvider, GenerationRequest } from "./types.js";

const BASE_URL = "https://api.openai.com/v1";

/**
 * OpenAI via the Responses API (https://platform.openai.com/docs/api-reference/responses),
 * with Structured Outputs (`text.format` = json_schema, strict).
 * `store: false` asks OpenAI not to retain the response for later retrieval.
 */
export class OpenAiProvider extends BaseProvider implements AiProvider {
  readonly id = "openai" as const;

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.options.apiKey ?? ""}`, "Content-Type": "application/json" };
  }

  async generate(request: GenerationRequest): Promise<string> {
    const body = {
      model: this.options.model,
      input: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      max_output_tokens: request.maxOutputTokens,
      store: false,
      text: {
        format: { type: "json_schema", name: "commit_message", strict: true, schema: request.schema },
      },
    };
    const res = asRecord(await this.call("POST", `${BASE_URL}/responses`, this.headers(), body));
    if (!res) throw this.fail("invalid_response", "OpenAI returned an unexpected response shape.");

    if (res.status === "incomplete") {
      const reason = asRecord(res.incomplete_details)?.reason;
      throw this.fail(
        "incomplete",
        `OpenAI stopped before finishing the reply (${typeof reason === "string" ? reason : "incomplete"}).`,
        "Try again, or choose a model that uses fewer reasoning tokens.",
      );
    }
    if (res.status === "failed") {
      const message = asRecord(res.error)?.message;
      throw this.fail("server", `OpenAI failed to generate a reply${typeof message === "string" ? `: ${message}` : "."}`);
    }

    const texts: string[] = [];
    for (const item of asArray(res.output)) {
      const rec = asRecord(item);
      if (rec?.type !== "message") continue;
      for (const part of asArray(rec.content)) {
        const p = asRecord(part);
        if (p?.type === "refusal") {
          throw this.fail("refusal", "OpenAI declined to generate a commit message for these changes.");
        }
        if (p?.type === "output_text" && typeof p.text === "string") texts.push(p.text);
      }
    }
    if (texts.length === 0) throw this.fail("invalid_response", "OpenAI returned no text output.");
    return texts.join("");
  }

  async ping(): Promise<void> {
    await this.call("GET", `${BASE_URL}/models/${encodeURIComponent(this.options.model)}`, this.headers());
  }
}

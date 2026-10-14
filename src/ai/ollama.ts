import { asArray, asRecord, BaseProvider } from "./base.js";
import type { AiProvider, GenerationRequest } from "./types.js";

export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";

/** Conservative characters-per-token for source code, used only to size the context window. */
const CHARS_PER_TOKEN = 2.5;

/**
 * The context window to request. Ollama's default window can be small and
 * silently truncates longer prompts, which would mean the model sees only part
 * of the diff. We size it from the actual prompt instead.
 */
export function ollamaContextWindow(request: GenerationRequest): number {
  const promptTokens = Math.ceil((request.system.length + request.user.length) / CHARS_PER_TOKEN);
  const needed = promptTokens + request.maxOutputTokens + 256;
  return Math.max(8192, Math.ceil(needed / 1024) * 1024);
}

/**
 * Local Ollama via `POST /api/chat` with a JSON-schema `format`
 * (https://github.com/ollama/ollama/blob/main/docs/api.md). Nothing leaves the machine.
 */
export class OllamaProvider extends BaseProvider implements AiProvider {
  readonly id = "ollama" as const;

  private base(): string {
    return (this.options.host ?? DEFAULT_OLLAMA_HOST).replace(/\/+$/, "");
  }

  async generate(request: GenerationRequest): Promise<string> {
    const body = {
      model: this.options.model,
      stream: false,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      format: request.schema,
      options: {
        temperature: 0,
        num_predict: request.maxOutputTokens,
        num_ctx: ollamaContextWindow(request),
      },
    };
    const res = asRecord(await this.call("POST", `${this.base()}/api/chat`, { "Content-Type": "application/json" }, body));
    if (!res) throw this.fail("invalid_response", "Ollama returned an unexpected response shape.");
    if (res.done_reason === "length") {
      throw this.fail("incomplete", "Ollama stopped before finishing the reply (output limit reached).", "Try again, or use a model that follows the JSON format more tightly.");
    }
    const content = asRecord(res.message)?.content;
    if (typeof content !== "string" || content === "") {
      throw this.fail("invalid_response", "Ollama returned no message content.");
    }
    return content;
  }

  async ping(): Promise<void> {
    const res = asRecord(await this.call("GET", `${this.base()}/api/tags`, {}));
    const names = asArray(res?.models)
      .map((m) => asRecord(m)?.name)
      .filter((n): n is string => typeof n === "string");
    const wanted = this.options.model;
    if (!names.some((n) => n === wanted || n === `${wanted}:latest`)) {
      throw this.fail(
        "not_found",
        `Ollama is running but model "${wanted}" is not installed.`,
        `Run \`ollama pull ${wanted}\`, or pick an installed model with \`checkin setup\`.`,
      );
    }
  }
}

/** Installed model names, for the setup picker. */
export async function listOllamaModels(
  host: string,
  fetchImpl: typeof fetch,
  timeoutMs = 5000,
): Promise<string[]> {
  const res = await fetchImpl(`${host.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = asRecord(await res.json());
  return asArray(json?.models)
    .map((m) => asRecord(m)?.name)
    .filter((n): n is string => typeof n === "string");
}

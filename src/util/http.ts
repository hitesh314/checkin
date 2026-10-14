import { redact } from "./redact.js";

export type HttpFailureKind = "timeout" | "network" | "status" | "too_large" | "invalid_json";

/** A failed HTTP exchange. Carries a redacted, truncated server message — never request contents. */
export class HttpError extends Error {
  constructor(
    readonly kind: HttpFailureKind,
    message: string,
    readonly status?: number,
    /** Number of attempts made before giving up. */
    readonly attempts: number = 1,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export type FetchLike = typeof fetch;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RequestOptions {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** Per-attempt timeout. */
  timeoutMs: number;
  /** Total attempts, including the first (1 = no retries). */
  maxAttempts: number;
  maxResponseBytes: number;
  fetch: FetchLike;
  sleep: Sleep;
  /** Secrets to strip from any message derived from the response. */
  secrets: readonly string[];
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const BASE_BACKOFF_MS = 500;
/** If a server asks us to wait longer than this, fail instead of hanging the terminal. */
const MAX_RETRY_AFTER_MS = 15_000;

function backoffMs(attempt: number, retryAfter: string | null): number | null {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      const ms = seconds * 1000;
      return ms > MAX_RETRY_AFTER_MS ? null : ms;
    }
  }
  return BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

async function readBounded(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Don't await: cancelling can wait on the stream's other consumers, and we are already giving up.
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Pull a human-readable message out of the usual `{error:{message}}` shapes. */
function serverMessage(text: string, secrets: readonly string[]): string {
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const err = parsed.error;
    if (typeof err === "string") message = err;
    else if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
      message = (err as { message: string }).message;
    } else if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // not JSON; use the raw text
  }
  return redact(message.replace(/\s+/g, " ").trim().slice(0, 300), secrets);
}

/**
 * JSON request with a per-attempt timeout and bounded retries for transient
 * failures (network errors, timeouts, 408/429/5xx). Client errors such as
 * 400/401/403/404 are never retried.
 */
export async function requestJson(options: RequestOptions): Promise<{ status: number; body: unknown }> {
  const { maxAttempts } = options;
  let lastError: HttpError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let retryAfter: string | null = null;
    try {
      const signal = AbortSignal.timeout(options.timeoutMs);
      const init: RequestInit = { method: options.method, headers: options.headers, signal };
      if (options.body !== undefined) init.body = JSON.stringify(options.body);
      const res = await options.fetch(options.url, init);
      const text = await readBounded(res, options.maxResponseBytes);
      if (text === null) {
        throw new HttpError("too_large", `response exceeded ${options.maxResponseBytes} bytes`, res.status, attempt);
      }
      if (res.ok) {
        try {
          return { status: res.status, body: text === "" ? null : JSON.parse(text) };
        } catch {
          throw new HttpError("invalid_json", "response was not valid JSON", res.status, attempt);
        }
      }
      retryAfter = res.headers.get("retry-after");
      lastError = new HttpError("status", serverMessage(text, options.secrets), res.status, attempt);
      if (!RETRYABLE_STATUS.has(res.status)) throw lastError;
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.kind !== "status" || !RETRYABLE_STATUS.has(e.status ?? 0)) throw e;
        lastError = e;
      } else if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        lastError = new HttpError("timeout", `no response within ${Math.round(options.timeoutMs / 1000)}s`, undefined, attempt);
      } else {
        // fetch() rejects with a bare TypeError("fetch failed") whose cause has the useful detail.
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        const detail = cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e));
        lastError = new HttpError("network", redact(String(detail), options.secrets), undefined, attempt);
      }
    }

    if (attempt === maxAttempts) break;
    const wait = backoffMs(attempt, retryAfter);
    if (wait === null) break;
    await options.sleep(wait);
  }

  throw new HttpError(lastError!.kind, lastError!.message, lastError!.status, lastError!.attempts);
}

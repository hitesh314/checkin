import type { AiProvider, GenerationRequest, ProviderId, ProviderOptions } from "../../src/ai/types.js";
import { createMemoryStore } from "../../src/credentials/store.js";
import type { CheckinDeps } from "../../src/workflow/checkin.js";
import { createBufferIo } from "../../src/util/io.js";
import { makeTempDir, type TestRepo } from "./repo.js";

export const VALID_REPLY = JSON.stringify({ subject: "feat: add the thing", body: "" });

type Reply = string | ((request: GenerationRequest, callIndex: number) => string | Promise<string>);

/** Provider that returns scripted replies and records everything it was asked. */
export class FakeProvider implements AiProvider {
  readonly id: ProviderId = "openai";
  readonly model = "fake-model";
  readonly requests: GenerationRequest[] = [];
  private readonly replies: Reply[];

  constructor(...replies: Reply[]) {
    this.replies = replies.length > 0 ? replies : [VALID_REPLY];
  }

  async generate(request: GenerationRequest): Promise<string> {
    const index = this.requests.length;
    this.requests.push(request);
    const reply = this.replies[Math.min(index, this.replies.length - 1)]!;
    return typeof reply === "function" ? reply(request, index) : reply;
  }

  async ping(): Promise<void> {}
}

export function reply(subject: string, body = ""): string {
  return JSON.stringify({ subject, body });
}

export interface TestContext {
  deps: CheckinDeps;
  io: ReturnType<typeof createBufferIo>;
  provider: FakeProvider;
  fetchCalls: Array<{ url: string; init: RequestInit }>;
  factoryOptions: ProviderOptions[];
}

/** Standard dependencies for exercising `runCheckin` in a temp repo with a fake provider. */
export function makeContext(
  repo: TestRepo,
  options: { provider?: FakeProvider; env?: Record<string, string>; cwd?: string; fetch?: typeof fetch; config?: object } = {},
): TestContext {
  const io = createBufferIo();
  const provider = options.provider ?? new FakeProvider();
  const configDir = makeTempDir("checkin-config-");
  const fetchCalls: TestContext["fetchCalls"] = [];
  const factoryOptions: ProviderOptions[] = [];
  const env = { CHECKIN_SECRET_SCAN: "off", CHECKIN_PROVIDER: "openai", OPENAI_API_KEY: "sk-test-0123456789abcdef0123", CHECKIN_CONFIG_DIR: configDir, ...options.env };
  const deps: CheckinDeps = {
    cwd: options.cwd ?? repo.dir,
    env,
    io,
    fetch:
      options.fetch ??
      (async (url, init) => {
        fetchCalls.push({ url: String(url), init: init ?? {} });
        throw new Error("unexpected network call in test");
      }),
    sleep: async () => {},
    secrets: createMemoryStore(),
    configLocation: { dir: configDir, file: `${configDir}/config.json` },
    inheritCommitStdio: false,
    providerFactory: (_id, opts) => {
      factoryOptions.push(opts);
      return provider;
    },
  };
  return { deps, io, provider, fetchCalls, factoryOptions };
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

type Responder = Response | Error | ((call: FetchCall) => Response | Promise<Response>);

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A fetch that never answers on its own; it rejects when the request's abort signal fires, like the real one. */
export const hang: Responder = (call) =>
  new Promise<Response>((_resolve, reject) => {
    call.signal?.addEventListener("abort", () => reject(call.signal!.reason));
  });

/** Scripted fetch: the nth call gets the nth responder (the last one repeats). */
export function mockFetch(...responders: Responder[]): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    const responder = responders[Math.min(calls.length - 1, responders.length - 1)]!;
    if (responder instanceof Error) throw responder;
    // Clone so the same scripted Response can be served repeatedly (a body can only be read once).
    return typeof responder === "function" ? responder(call) : responder.clone();
  };
  return { fetch: impl as typeof fetch, calls };
}

/** Await a promise that must reject; returns the rejection value, and fails loudly if it resolved instead. */
export async function rejection<E = Error & { kind?: string; hint?: string }>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (e) {
    return e as E;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

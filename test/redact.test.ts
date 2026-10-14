import { describe, expect, it } from "vitest";
import { createProvider } from "../src/ai/registry.js";
import { runDoctor } from "../src/commands/doctor.js";
import { createMemoryStore } from "../src/credentials/store.js";
import { createBufferIo } from "../src/util/io.js";
import { describeSecret, redact, REDACTED, secretVariants } from "../src/util/redact.js";
import { runCheckin } from "../src/workflow/checkin.js";
import { FakeProvider, jsonResponse, makeContext, mockFetch, reply, rejection } from "./helpers/fakes.js";
import { createRepo, makeTempDir } from "./helpers/repo.js";

const OPENAI = "sk-proj-AbCdEf0123456789AbCdEf0123456789";
const ANTHROPIC = "sk-ant-api03-ZyXwVu9876543210ZyXwVu9876543210";
const GOOGLE = "AIzaSyA-1234567890abcdefghijklmnopqrstuv";
const ATLASSIAN = "ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz0123456789";

describe("redact()", () => {
  it.each([
    ["an OpenAI key", `key is ${OPENAI} ok`, OPENAI],
    ["an Anthropic key", `key is ${ANTHROPIC} ok`, ANTHROPIC],
    ["a Google key", `key is ${GOOGLE} ok`, GOOGLE],
    ["an Atlassian token", `token ${ATLASSIAN}`, ATLASSIAN],
    ["a Bearer header", "Authorization: Bearer abcdef1234567890abcdef", "abcdef1234567890abcdef"],
    ["a Basic header", "authorization: Basic ZGV2QGFjbWUuY29tOnNlY3JldHRva2Vu", "ZGV2QGFjbWUuY29tOnNlY3JldHRva2Vu"],
    ["an x-api-key header", "x-api-key: totally-custom-format-key", "totally-custom-format-key"],
    ["an x-goog-api-key header in JSON", '{"x-goog-api-key":"custom-google-key-value"}', "custom-google-key-value"],
    ["credentials in a URL", "fetch failed https://user:hunter2hunter2@proxy.example/x", "hunter2hunter2"],
    ["a key in a query string", "GET /v1/models?key=querystringsecret&alt=json", "querystringsecret"],
  ])("removes %s", (_name, text, secret) => {
    const out = redact(text);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it("removes exact secrets the process holds, in any format", () => {
    expect(redact("the value is hunter2-custom-secret!", ["hunter2-custom-secret"])).toBe(`the value is ${REDACTED}!`);
    expect(redact("a b c", ["a"])).toBe("a b c"); // too short to match safely
  });

  it("removes the base64 form used in Basic auth", () => {
    const [token, basic] = secretVariants("tok-1234567890", "me@x.y");
    expect(basic).toBe(Buffer.from("me@x.y:tok-1234567890").toString("base64"));
    expect(redact(`Basic-ish ${basic} and ${token}`, [token!, basic!])).toBe(`Basic-ish ${REDACTED} and ${REDACTED}`);
  });

  it("leaves ordinary text alone", () => {
    const text = "feat(parser): add retry (see sk-learn docs) at https://example.com/path?x=1";
    expect(redact(text)).toBe(text);
  });

  it("describes a secret without revealing any part of it", () => {
    expect(describeSecret(OPENAI)).toBe(`set (${OPENAI.length} characters)`);
    expect(describeSecret(OPENAI)).not.toContain("sk-");
    expect(describeSecret(undefined)).toBe("not set");
  });
});

describe("Io", () => {
  it("redacts registered secrets from everything it prints", () => {
    const io = createBufferIo();
    io.addSecrets("my-private-value-123");
    io.out("hello my-private-value-123");
    io.err("oops my-private-value-123");
    expect(io.text()).not.toContain("my-private-value-123");
    expect(io.text()).toContain(REDACTED);
  });
});

describe("end to end: credentials do not leak", () => {
  it("a provider error that echoes the key is redacted in what the user sees", async () => {
    const repo = createRepo();
    repo.write("a.txt", "a\n");
    const fetched = mockFetch(jsonResponse({ error: { message: `Incorrect API key provided: ${OPENAI}` } }, 401));
    const io = createBufferIo();
    const ctx = makeContext(repo, { env: { OPENAI_API_KEY: OPENAI } });
    ctx.deps.providerFactory = (id, options) => createProvider(id, { ...options, fetch: fetched.fetch });
    Object.assign(ctx.deps, { io });

    const err = await rejection<Error & { hint?: string }>(runCheckin({ preview: false, staged: false }, ctx.deps));

    expect(err.message).not.toContain(OPENAI);
    expect(`${err.message}\n${err.hint}`).not.toContain(OPENAI);
    expect(io.text()).not.toContain(OPENAI);
    expect(fetched.calls[0]!.headers.authorization).toBe(`Bearer ${OPENAI}`); // it was sent to OpenAI only
  });

  it("successful runs print neither the key, the diff, nor Jira content", async () => {
    const repo = createRepo();
    repo.write("secret-plan.txt", "UNIQUE-DIFF-CONTENT-12345\n");
    const ctx = makeContext(repo, { provider: new FakeProvider(reply("feat: add plan")), env: { OPENAI_API_KEY: OPENAI } });

    await runCheckin({ preview: false, staged: false }, ctx.deps);

    const output = ctx.io.text();
    expect(output).not.toContain(OPENAI);
    expect(output).not.toContain("UNIQUE-DIFF-CONTENT-12345");
    expect(output).not.toContain("diff --git");
  });

  it("does not echo Jira ticket content (it only goes to the provider)", async () => {
    const repo = createRepo();
    repo.git("switch", "-q", "-c", "PROJ-1-x");
    repo.write("a.txt", "a\n");
    const issue = { fields: { summary: "CONFIDENTIAL-TICKET-SUMMARY", description: "CONFIDENTIAL-TICKET-BODY" } };
    const ctx = makeContext(repo, {
      fetch: mockFetch(jsonResponse(issue)).fetch,
      env: { CHECKIN_JIRA_SITE_URL: "https://a.atlassian.net", CHECKIN_JIRA_EMAIL: "a@b.c", CHECKIN_JIRA_API_TOKEN: ATLASSIAN },
    });

    await runCheckin({ preview: false, staged: false }, ctx.deps);

    expect(ctx.io.text()).not.toContain("CONFIDENTIAL");
    expect(ctx.io.text()).not.toContain(ATLASSIAN);
    expect(ctx.provider.requests[0]!.user).toContain("CONFIDENTIAL-TICKET-SUMMARY");
  });

  it("doctor never prints a key and reports only where it was found", async () => {
    const dir = makeTempDir();
    const io = createBufferIo();
    const fetched = mockFetch(jsonResponse({ id: "ok" }));
    const ok = await runDoctor({
      cwd: dir,
      env: { CHECKIN_PROVIDER: "openai", OPENAI_API_KEY: OPENAI, CHECKIN_CONFIG_DIR: dir },
      io,
      secrets: createMemoryStore(),
      configLocation: { dir, file: `${dir}/config.json` },
      fetch: fetched.fetch,
      sleep: async () => {},
    });

    expect(ok).toBe(true);
    expect(io.text()).not.toContain(OPENAI);
    expect(io.text()).toContain("API key found (environment variable OPENAI_API_KEY)");
  });
});

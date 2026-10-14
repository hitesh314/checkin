/**
 * Credential redaction. Everything that reaches the terminal goes through
 * `redact`, so that a key echoed back by a provider error body, a proxy, or a
 * stack trace never lands in the user's scrollback or in CI logs.
 *
 * Two layers:
 *  1. exact-match redaction of the secrets this process actually holds, and
 *  2. pattern-based redaction of well-known credential shapes and headers.
 */

export const REDACTED = "[REDACTED]";

const PATTERNS: Array<[RegExp, string]> = [
  // Header lines, e.g. "Authorization: Bearer abc", "x-api-key: abc".
  [/\b(authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key)\b(\s*["']?\s*[:=]\s*["']?)[^\r\n"',}]+/gi, `$1$2${REDACTED}`],
  // Bearer / Basic credentials anywhere in a string.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`],
  // Provider key shapes (OpenAI sk-…, Anthropic sk-ant-…, Google AIza…).
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED],
  // Atlassian API tokens.
  [/\bATATT[0-9A-Za-z_\-=.]{20,}/g, REDACTED],
  // Credentials embedded in URLs: https://user:secret@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Query-string keys: ?key=…&api_key=…
  [/([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi, `$1${REDACTED}`],
];

/** Secrets shorter than this are not exact-matched (too likely to mangle ordinary text). */
const MIN_EXACT_LENGTH = 6;

export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_EXACT_LENGTH) {
      out = out.split(secret).join(REDACTED);
    }
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Derive the extra forms in which a secret can appear (e.g. base64 for Basic auth). */
export function secretVariants(secret: string, companion?: string): string[] {
  const variants = [secret];
  if (companion !== undefined) {
    variants.push(Buffer.from(`${companion}:${secret}`).toString("base64"));
  }
  return variants;
}

/** Show only that a secret exists, never any part of it. */
export function describeSecret(secret: string | undefined): string {
  return secret ? `set (${secret.length} characters)` : "not set";
}

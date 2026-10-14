import { CheckinError } from "../util/errors.js";

export const MAX_SUBJECT_LENGTH = 72;
export const MAX_BODY_LENGTH = 3000;
const MAX_RAW_LENGTH = 20_000;

export class InvalidModelOutputError extends CheckinError {
  constructor(readonly reason: string) {
    super(`The model returned an unusable commit message: ${reason}`, {
      hint: "Nothing was committed and your changes are still staged. Run checkin again, or try a different model with `checkin setup`.",
    });
  }
}

export interface CommitMessageParts {
  subject: string;
  body: string;
}

const CONVENTIONAL_SUBJECT = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([A-Za-z0-9._/@ -]+\))?!?: \S/;

// Control characters other than tab/newline (which are checked separately for each field).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/**
 * Directives an attacker could plant in a diff or ticket to make the model emit
 * something with side effects outside the commit itself. We reject rather than
 * silently edit: the user can simply re-run.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|\*\*\*NO_CI\*\*\*|skip-checks:\s*true/i, "contains a CI-skip directive"],
  [/(^|\s)#(?:close|closed|done|resolve|resolved|reopen|comment|time|transition|in-progress|start-progress|stop-progress)\b/i, "contains a Jira smart-commit command"],
  [/^(?:co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by)\s*:/im, "contains an attribution trailer the tool did not add"],
];

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some models wrap JSON in a code fence despite instructions; accept exactly that one form.
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
    if (fenced?.[1] !== undefined) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        /* fall through */
      }
    }
    throw new InvalidModelOutputError("the reply was not valid JSON");
  }
}

/** Parse and validate the model's raw reply. Throws InvalidModelOutputError with a reason safe to feed back to the model. */
export function parseModelOutput(raw: string): CommitMessageParts {
  if (raw.length > MAX_RAW_LENGTH) throw new InvalidModelOutputError("the reply was far longer than a commit message");
  const data = extractJson(raw);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new InvalidModelOutputError('the reply was not a JSON object with "subject" and "body"');
  }
  const record = data as Record<string, unknown>;

  if (typeof record.subject !== "string") throw new InvalidModelOutputError('"subject" was missing or not a string');
  const subject = record.subject.trim();
  if (subject === "") throw new InvalidModelOutputError('"subject" was empty');
  if (/[\r\n]/.test(subject)) throw new InvalidModelOutputError('"subject" spanned multiple lines');
  if (CONTROL_CHARS.test(subject)) throw new InvalidModelOutputError('"subject" contained control characters');
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw new InvalidModelOutputError(`"subject" was ${subject.length} characters; the limit is ${MAX_SUBJECT_LENGTH}`);
  }
  if (!CONVENTIONAL_SUBJECT.test(subject)) {
    throw new InvalidModelOutputError('"subject" was not in Conventional Commits form "type(scope): summary"');
  }
  if (subject.endsWith(".")) throw new InvalidModelOutputError('"subject" ended with a period');

  const rawBody = record.body ?? "";
  if (typeof rawBody !== "string") throw new InvalidModelOutputError('"body" was not a string');
  const body = rawBody.replace(/\r\n?/g, "\n").trim();
  if (body.length > MAX_BODY_LENGTH) {
    throw new InvalidModelOutputError(`"body" was ${body.length} characters; the limit is ${MAX_BODY_LENGTH}`);
  }
  if (CONTROL_CHARS.test(body)) throw new InvalidModelOutputError('"body" contained control characters');

  for (const [pattern, why] of FORBIDDEN) {
    if (pattern.test(subject) || pattern.test(body)) throw new InvalidModelOutputError(`the message ${why}`);
  }

  return { subject, body };
}

/**
 * Assemble the final commit message. The ticket reference is added here, in
 * application code, as a `Refs:` footer — never by the model.
 */
export function composeCommitMessage(parts: CommitMessageParts, ticketId?: string): string {
  let message = parts.subject;
  if (parts.body !== "") message += `\n\n${parts.body}`;
  if (ticketId !== undefined) {
    const footer = `Refs: ${ticketId}`;
    const already = parts.body.split("\n").some((line) => line.trim() === footer);
    if (!already) message += `\n\n${footer}`;
  }
  return message;
}

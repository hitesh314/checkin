import type { AiProvider } from "../ai/types.js";
import type { StagedFile } from "../git/changes.js";
import { buildPrompt, type JiraContext } from "../prompt/build.js";
import { CheckinError } from "../util/errors.js";
import { COMMIT_SCHEMA } from "./schema.js";
import { composeCommitMessage, InvalidModelOutputError, parseModelOutput, type CommitMessageParts } from "./validate.js";

export const DEFAULT_MAX_DIFF_BYTES = 100_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
/** One initial attempt plus one corrective re-ask when the reply fails validation. */
const MAX_OUTPUT_ATTEMPTS = 2;

export class InputTooLargeError extends CheckinError {
  constructor(sizeDescription: string, limit: number) {
    super(`The staged diff is too large to send to the AI provider (${sizeDescription}; limit ${limit} bytes).`, {
      hint:
        "Nothing was sent and nothing was committed. Commit in smaller pieces (stage a subset and use `checkin --staged`), " +
        "keep generated or vendored files out of the commit, or raise the limit with CHECKIN_MAX_DIFF_BYTES.",
    });
  }
}

export interface GenerateInput {
  branch: string | null;
  files: StagedFile[];
  diff: string;
  jira?: JiraContext;
  /** Appended to the message deterministically; never shown to the model. */
  ticketId?: string;
}

export interface GenerateOptions {
  provider: AiProvider;
  maxDiffBytes: number;
  maxOutputTokens: number;
}

export interface GeneratedMessage extends CommitMessageParts {
  /** The complete text that will be passed to `git commit -m`. */
  message: string;
}

/**
 * Turn staged changes (+ optional ticket) into a validated commit message.
 * Knows nothing about git staging or committing, so it can be tested alone.
 */
export async function generateCommitMessage(input: GenerateInput, options: GenerateOptions): Promise<GeneratedMessage> {
  const bytes = Buffer.byteLength(input.diff);
  if (bytes > options.maxDiffBytes) throw new InputTooLargeError(`${bytes} bytes`, options.maxDiffBytes);

  let feedback: string | undefined;
  for (let attempt = 1; ; attempt++) {
    const prompt = buildPrompt(input, feedback);
    const raw = await options.provider.generate({
      system: prompt.system,
      user: prompt.user,
      schema: COMMIT_SCHEMA,
      maxOutputTokens: options.maxOutputTokens,
    });
    try {
      const parts = parseModelOutput(raw);
      return { ...parts, message: composeCommitMessage(parts, input.ticketId) };
    } catch (e) {
      if (!(e instanceof InvalidModelOutputError) || attempt >= MAX_OUTPUT_ATTEMPTS) throw e;
      feedback = e.reason;
    }
  }
}

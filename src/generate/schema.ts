import type { JsonSchema } from "../ai/types.js";

/**
 * The structured reply we ask for. `body` is required-but-may-be-empty because
 * strict structured-output modes require every property to be listed as required.
 * Length and format limits are enforced in `validate.ts`, not here: not every
 * provider honours `maxLength`/`pattern` in its schema subset.
 */
export const COMMIT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    subject: {
      type: "string",
      description: "Conventional Commit subject line: type(scope): summary. Imperative mood, at most 72 characters, no trailing period.",
    },
    body: {
      type: "string",
      description: "Optional explanation of what changed and why, as short paragraphs or bullets. Empty string if the subject is sufficient.",
    },
  },
  required: ["subject", "body"],
  additionalProperties: false,
};

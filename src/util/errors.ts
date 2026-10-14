/**
 * Errors that are safe to show to the user. `message` says what happened;
 * `hint` says what to do next. Both are passed through credential redaction
 * before being printed.
 */
export class CheckinError extends Error {
  hint: string | undefined;
  readonly exitCode: number;

  constructor(message: string, options: { hint?: string; exitCode?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}

/** The user asked for something the tool does not support (bad flags, unsupported repo state, …). */
export class UsageError extends CheckinError {}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Add a sentence to an error's hint without changing its type. */
export function appendHint(err: CheckinError, extra: string): void {
  err.hint = err.hint ? `${err.hint}\n${extra}` : extra;
}

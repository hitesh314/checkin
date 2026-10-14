import * as clack from "@clack/prompts";
import { CheckinError } from "../util/errors.js";

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** The handful of interactions `setup` needs. Abstracted so tests can script answers. */
export interface Prompter {
  intro(message: string): void;
  outro(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  select<T extends string>(message: string, choices: Choice<T>[], initial?: T): Promise<T>;
  text(message: string, options?: { initial?: string; placeholder?: string; validate?: (value: string) => string | undefined }): Promise<string>;
  /** Input is masked as it is typed. */
  password(message: string, validate?: (value: string) => string | undefined): Promise<string>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
}

function unwrap<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new CheckinError("Setup cancelled; nothing was saved.");
  return value as Exclude<T, symbol>;
}

export function createClackPrompter(): Prompter {
  return {
    intro: (m) => clack.intro(m),
    outro: (m) => clack.outro(m),
    info: (m) => clack.log.info(m),
    warn: (m) => clack.log.warn(m),
    async select(message, choices, initial) {
      const options = choices.map((c) => ({ value: c.value, label: c.label, ...(c.hint ? { hint: c.hint } : {}) }));
      return unwrap(await clack.select<string>({ message, options, ...(initial ? { initialValue: initial } : {}) })) as never;
    },
    async text(message, options = {}) {
      const result = await clack.text({
        message,
        ...(options.initial !== undefined ? { initialValue: options.initial } : {}),
        ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
        ...(options.validate ? { validate: (v: string | undefined) => options.validate!(v ?? "") } : {}),
      });
      return unwrap(result).trim();
    },
    async password(message, validate) {
      const result = await clack.password({
        message,
        mask: "•",
        ...(validate ? { validate: (v: string | undefined) => validate(v ?? "") } : {}),
      });
      return unwrap(result).trim();
    },
    async confirm(message, initial = true) {
      return unwrap(await clack.confirm({ message, initialValue: initial }));
    },
  };
}

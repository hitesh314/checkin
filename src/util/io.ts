import { redact } from "./redact.js";

/** Terminal output channel. Injected so the workflow can be tested without touching process streams. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Register additional secrets that must never be printed. */
  addSecrets(...secrets: string[]): void;
}

export function createProcessIo(): Io {
  const secrets: string[] = [];
  return {
    out: (line) => process.stdout.write(`${redact(line, secrets)}\n`),
    err: (line) => process.stderr.write(`${redact(line, secrets)}\n`),
    addSecrets: (...more) => {
      for (const s of more) if (s) secrets.push(s);
    },
  };
}

/** In-memory Io for tests. */
export function createBufferIo(): Io & { stdout: string[]; stderr: string[]; text(): string } {
  const secrets: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => void stdout.push(redact(line, secrets)),
    err: (line) => void stderr.push(redact(line, secrets)),
    addSecrets: (...more) => {
      for (const s of more) if (s) secrets.push(s);
    },
    text: () => [...stdout, ...stderr].join("\n"),
  };
}

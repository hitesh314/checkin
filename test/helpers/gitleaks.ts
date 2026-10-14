import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./repo.js";

export interface FakeGitleaks {
  /** Path to the executable stand-in for `gitleaks`. */
  path: string;
  /** Arguments of each scan invocation (everything except `version`). */
  scans(): string[][];
}

/**
 * A shell script that behaves like the parts of gitleaks checkin uses:
 * `version`, and a scan that prints a JSON report and exits with a chosen code.
 */
export function fakeGitleaks(options: { version?: string; exitCode?: number; report?: unknown; stderr?: string } = {}): FakeGitleaks {
  const dir = makeTempDir("fake-gitleaks-");
  const log = join(dir, "scans.log");
  const report = join(dir, "report.json");
  writeFileSync(report, JSON.stringify(options.report ?? []));
  writeFileSync(log, "");
  const script = `#!/bin/sh
if [ "$1" = "version" ]; then echo "${options.version ?? "8.21.2"}"; exit 0; fi
printf '%s\\n' "$*" >> "${log}"
cat "${report}"
${options.stderr ? `echo "${options.stderr}" >&2` : ""}
exit ${options.exitCode ?? 0}
`;
  const path = join(dir, "gitleaks");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return {
    path,
    scans: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split(" ")),
  };
}

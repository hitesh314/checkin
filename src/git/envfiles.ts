/**
 * Environment files (`.env`, `.env.local`, `prod.env`, `.envrc`, a `.env/`
 * directory …) usually hold secrets. checkin never stages them automatically
 * and refuses to send one that is already staged.
 *
 * Template files that are meant to be committed (`.env.example`, `.env.sample`,
 * `.env.template`, `.env.dist`) are allowed.
 */
const TEMPLATE_SUFFIXES = new Set(["example", "sample", "template", "dist"]);

function isEnvComponent(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env" || lower === ".envrc") return true;
  if (lower.startsWith(".env.")) return !TEMPLATE_SUFFIXES.has(lower.slice(".env.".length));
  return lower.endsWith(".env") && lower.length > ".env".length;
}

/** True when any component of the repository-relative path is an environment file or directory. */
export function isEnvironmentFile(path: string): boolean {
  return path.split("/").some((part) => part !== "" && isEnvComponent(part));
}

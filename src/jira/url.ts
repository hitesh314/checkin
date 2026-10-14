import { CheckinError } from "../util/errors.js";

/**
 * Normalise a Jira Cloud site address to its origin. Accepts "acme.atlassian.net"
 * or a full URL; rejects anything that is not https, because Basic/Bearer
 * credentials are sent to this host.
 */
export function normalizeSiteUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CheckinError(`"${input}" is not a valid Jira site address.`, { hint: "Use something like https://your-company.atlassian.net" });
  }
  if (url.protocol !== "https:") {
    throw new CheckinError("The Jira site address must use https:// so credentials are never sent in clear text.");
  }
  if (url.username || url.password) {
    throw new CheckinError("Do not put credentials in the Jira site address.");
  }
  return url.origin;
}

const TICKET_KEY = /^[A-Z][A-Z0-9_]+-[1-9][0-9]*$/;

/** Validate and normalise an explicit `--ticket` value (case-insensitive input, upper-case output). */
export function parseTicketKey(input: string): string {
  const key = input.trim().toUpperCase();
  if (!TICKET_KEY.test(key)) {
    throw new CheckinError(`"${input}" is not a valid Jira ticket key.`, { hint: "Use the form PROJ-123." });
  }
  return key;
}

// Project key: upper-case start, then upper-case letters/digits/underscore; number has no leading zero.
// Alphanumeric boundaries stop matches inside longer words (e.g. "XPROJ-1abc") while still
// allowing "_" or "-" or "/" as separators ("feature_PROJ-1_fix").
const BRANCH_TICKET = /(?<![A-Za-z0-9])[A-Z][A-Z0-9_]+-[1-9][0-9]*(?![A-Za-z0-9])/g;

export type BranchTicket = { kind: "none" } | { kind: "one"; key: string } | { kind: "many"; keys: string[] };

/** Find Jira keys in a branch name such as `feature/PROJ-123-parser-retry`. Detection is upper-case only, to avoid matching things like `utf-8`. */
export function detectTicketInBranch(branch: string | null): BranchTicket {
  if (!branch) return { kind: "none" };
  const keys = [...new Set(branch.match(BRANCH_TICKET) ?? [])];
  if (keys.length === 0) return { kind: "none" };
  if (keys.length === 1) return { kind: "one", key: keys[0]! };
  return { kind: "many", keys };
}

import { CheckinError } from "../util/errors.js";
import { detectTicketInBranch, parseTicketKey } from "./url.js";

export interface TicketChoice {
  key: string;
  source: "flag" | "branch";
}

const ESCAPES =
  "Pass it explicitly with `--ticket PROJ-123`, use a branch named like PROJ-123-short-description, " +
  "or run `checkin setup` and disable Jira.";

/**
 * Decide which ticket applies.
 *  - `--ticket` always wins.
 *  - Otherwise, when Jira is configured, the branch name must identify exactly one ticket.
 *  - When Jira is not configured and no flag is given, there is no ticket (branch names are not guessed from).
 */
export function chooseTicket(args: { flag: string | undefined; branch: string | null; jiraConfigured: boolean }): TicketChoice | null {
  if (args.flag !== undefined) return { key: parseTicketKey(args.flag), source: "flag" };
  if (!args.jiraConfigured) return null;

  const found = detectTicketInBranch(args.branch);
  switch (found.kind) {
    case "one":
      return { key: found.key, source: "branch" };
    case "none":
      throw new CheckinError(`Jira is configured, but no ticket key was found in the branch name "${args.branch ?? ""}".`, { hint: ESCAPES });
    case "many":
      throw new CheckinError(`The branch name "${args.branch ?? ""}" contains more than one ticket key (${found.keys.join(", ")}).`, {
        hint: "Choose one with `--ticket PROJ-123`.",
      });
  }
}

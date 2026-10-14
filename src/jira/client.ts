import type { ResolvedJira } from "../config/settings.js";
import { CheckinError } from "../util/errors.js";
import { HttpError, requestJson, type FetchLike, type Sleep } from "../util/http.js";
import { secretVariants } from "../util/redact.js";
import { adfToText } from "./adf.js";

export interface JiraIssue {
  key: string;
  summary: string;
  /** Description converted to plain text; empty when the ticket has none. */
  description: string;
}

export type JiraFailureKind = "auth" | "forbidden" | "not_found" | "rate_limit" | "server" | "timeout" | "network" | "invalid_response" | "cloud_id";

export class JiraError extends CheckinError {
  constructor(
    readonly kind: JiraFailureKind,
    message: string,
    hint?: string,
  ) {
    super(message, hint === undefined ? {} : { hint });
  }
}

export interface JiraDeps {
  fetch: FetchLike;
  sleep: Sleep;
  timeoutMs: number;
  maxAttempts: number;
}

const MAX_RESPONSE_BYTES = 2_000_000;
const GATEWAY = "https://api.atlassian.com/ex/jira";

function rec(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Read-only Jira Cloud client (REST API v3).
 *
 * - `api-token`: Basic auth (email:token) against the site URL.
 * - `scoped-api-token`: Basic auth against the api.atlassian.com gateway, which scoped tokens require.
 * - `service-account-token`: Bearer auth against the gateway.
 *
 * The gateway URL needs the site's cloud id, resolved from `<site>/_edge/tenant_info` unless configured.
 */
export class JiraClient {
  private cloudId: string | undefined;

  constructor(
    private readonly settings: ResolvedJira,
    private readonly deps: JiraDeps,
  ) {
    this.cloudId = settings.cloudId;
  }

  private secrets(): string[] {
    const { token, email } = this.settings;
    return secretVariants(token, email);
  }

  private authHeader(): string {
    const { authType, token, email } = this.settings;
    if (authType === "service-account-token") return `Bearer ${token}`;
    return `Basic ${Buffer.from(`${email ?? ""}:${token}`).toString("base64")}`;
  }

  private async request(url: string, authenticated = true): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (authenticated) headers.Authorization = this.authHeader();
    try {
      const { body } = await requestJson({
        method: "GET",
        url,
        headers,
        timeoutMs: this.deps.timeoutMs,
        maxAttempts: this.deps.maxAttempts,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        fetch: this.deps.fetch,
        sleep: this.deps.sleep,
        secrets: this.secrets(),
      });
      return body;
    } catch (e) {
      if (e instanceof HttpError) throw this.translate(e);
      throw e;
    }
  }

  private translate(e: HttpError): JiraError {
    const tries = e.attempts > 1 ? ` after ${e.attempts} attempts` : "";
    switch (e.kind) {
      case "timeout":
        return new JiraError("timeout", `Jira did not respond in time${tries}.`, "Try again, or raise the timeout with CHECKIN_TIMEOUT_MS.");
      case "network":
        return new JiraError("network", `Could not reach Jira${tries}: ${e.message}.`, "Check your network connection and the site URL.");
      case "too_large":
      case "invalid_json":
        return new JiraError("invalid_response", "Jira returned a response that could not be read.");
      case "status":
        break;
    }
    switch (e.status) {
      case 401:
        return new JiraError(
          "auth",
          "Jira rejected the credentials (HTTP 401).",
          this.settings.authType === "api-token"
            ? "Check the email and API token. If you created the token with scopes, run `checkin setup` and choose the scoped token type."
            : "Check the email/token, that the token has not expired, and that the cloud id is for this site.",
        );
      case 403:
        return new JiraError("forbidden", "Jira denied access (HTTP 403).", "The account may lack permission, or a scoped token may be missing the read:jira-work scope.");
      case 404:
        return new JiraError("not_found", "Jira returned 404 Not Found.", "Check the ticket key. Jira also answers 404 when the account cannot see the ticket.");
      case 429:
        return new JiraError("rate_limit", `Jira rate limit reached${tries}.`, "Wait a moment and try again.");
      default:
        return new JiraError("server", `Jira returned HTTP ${e.status}${tries}.`, "This is usually temporary; try again.");
    }
  }

  private async resolveCloudId(): Promise<string> {
    if (this.cloudId !== undefined) return this.cloudId;
    const body = rec(await this.request(`${this.settings.siteUrl}/_edge/tenant_info`, false));
    const id = body?.cloudId;
    if (typeof id !== "string" || id === "") {
      throw new JiraError("cloud_id", "Could not determine the Jira cloud id for this site.", "Check the site URL, or set CHECKIN_JIRA_CLOUD_ID.");
    }
    this.cloudId = id;
    return id;
  }

  /** The cloud id used for gateway URLs; exposed for setup to store. */
  async discoverCloudId(): Promise<string> {
    return this.resolveCloudId();
  }

  private async baseUrl(): Promise<string> {
    if (this.settings.authType === "api-token") return this.settings.siteUrl;
    return `${GATEWAY}/${encodeURIComponent(await this.resolveCloudId())}`;
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const url = `${await this.baseUrl()}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description`;
    let body: unknown;
    try {
      body = await this.request(url);
    } catch (e) {
      if (e instanceof JiraError && e.kind === "not_found") {
        throw new JiraError("not_found", `Jira ticket ${key} was not found.`, e.hint);
      }
      throw e;
    }
    const fields = rec(rec(body)?.fields);
    const summary = fields?.summary;
    if (typeof summary !== "string") {
      throw new JiraError("invalid_response", `Jira returned ticket ${key} without a summary.`);
    }
    return { key, summary: summary.trim(), description: adfToText(fields?.description) };
  }

  /** Credential/connectivity check for `checkin doctor`. Does not read any ticket. */
  async ping(): Promise<{ account?: string }> {
    const body = rec(await this.request(`${await this.baseUrl()}/rest/api/3/myself`));
    const name = body?.displayName;
    return typeof name === "string" ? { account: name } : {};
  }
}

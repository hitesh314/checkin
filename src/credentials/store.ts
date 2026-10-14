/**
 * Secret storage. Secrets live only in the operating system's credential store
 * (macOS Keychain, Windows Credential Manager, Linux Secret Service) or in
 * environment variables. There is deliberately no plaintext-file fallback.
 */
export interface SecretStore {
  readonly name: string;
  /** Can this store be used right now? (e.g. false on a headless Linux box with no Secret Service). */
  check(): Promise<{ ok: true } | { ok: false; reason: string }>;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}

export const KEYCHAIN_SERVICE = "checkin";

export const accounts = {
  apiKey: (provider: string) => `${provider}-api-key`,
  jiraToken: "jira-api-token",
} as const;

type KeyringModule = typeof import("@napi-rs/keyring");

/** OS credential store via @napi-rs/keyring, loaded lazily so a missing native binary cannot crash unrelated commands. */
export function createKeyringStore(service: string = KEYCHAIN_SERVICE): SecretStore {
  let loaded: Promise<KeyringModule> | undefined;
  const load = () => (loaded ??= import("@napi-rs/keyring"));
  const entry = async (account: string) => new (await load()).Entry(service, account);

  return {
    name: "operating system credential store",
    async check() {
      try {
        // Reading a non-existent entry is harmless and fails if there is no backend.
        (await entry("availability-probe")).getPassword();
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
    async get(account) {
      return (await entry(account)).getPassword() ?? null;
    },
    async set(account, secret) {
      (await entry(account)).setPassword(secret);
    },
    async delete(account) {
      try {
        return (await entry(account)).deletePassword();
      } catch {
        return false;
      }
    },
  };
}

/** In-memory store for tests. */
export function createMemoryStore(initial: Record<string, string> = {}, available = true): SecretStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    name: "memory",
    async check() {
      return available ? { ok: true } : { ok: false, reason: "no credential backend (test)" };
    },
    async get(account) {
      if (!available) throw new Error("no credential backend (test)");
      return data.get(account) ?? null;
    },
    async set(account, secret) {
      if (!available) throw new Error("no credential backend (test)");
      data.set(account, secret);
    },
    async delete(account) {
      return data.delete(account);
    },
  };
}

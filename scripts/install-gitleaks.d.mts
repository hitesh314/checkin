export const GITLEAKS_VERSION: string;
export const GITLEAKS_SHA256: Record<string, string>;
export const VENDOR_DIR: string;
export function assetSuffix(platform?: string, arch?: string, armVersion?: unknown): string | null;
export function binaryName(platform?: string): string;
export function downloadUrl(suffix: string, version?: string): string;
export function sha256(buffer: Buffer): string;
export function verifyArchive(buffer: Buffer, suffix: string, pinned?: Record<string, string>): void;
export function installGitleaks(options?: {
  fetchImpl?: typeof fetch;
  vendorDir?: string;
  platform?: string;
  arch?: string;
  log?: (message: string) => void;
  pinned?: Record<string, string>;
}): Promise<{ path: string; alreadyInstalled: boolean }>;

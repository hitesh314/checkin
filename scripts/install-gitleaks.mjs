#!/usr/bin/env node
/**
 * Installs the pinned Gitleaks release into `<package>/vendor/` so secret scanning
 * works as soon as checkin is installed. Runs as the package's `postinstall` step.
 *
 * Safety properties:
 *  - the version and the SHA-256 of every archive are pinned below, so the download
 *    is checked against hashes shipped in this package, not hashes fetched alongside it;
 *  - the download comes only from github.com/gitleaks/gitleaks release assets;
 *  - a failure NEVER fails `npm install`: it prints how to install gitleaks manually
 *    (checkin then uses a `gitleaks` on your PATH, or warns that nothing is scanned).
 *
 * Opt out with CHECKIN_SKIP_GITLEAKS_DOWNLOAD=1. Re-run with `npm run install-gitleaks`.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GITLEAKS_VERSION = "8.30.1";

/** SHA-256 of each release archive, from gitleaks_8.30.1_checksums.txt. Update together with GITLEAKS_VERSION. */
export const GITLEAKS_SHA256 = {
  "darwin_arm64.tar.gz": "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  "darwin_x64.tar.gz": "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
  "linux_arm64.tar.gz": "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
  "linux_armv6.tar.gz": "5c2a4ee657a27614e10352bed2b8f1018ef9b05fc6c037cf737776bbe1255766",
  "linux_armv7.tar.gz": "8d39f0d94ba0d774b2282187656fb039a2d82893ec1fd6be7d7121aae759a57d",
  "linux_x32.tar.gz": "a87ba11adab22b4d6c6ea28b2da60f09154d5c2fdb44d4b07015d1e0433daecb",
  "linux_x64.tar.gz": "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  "windows_arm64.zip": "b95f5e4f5c425cedca7ee203d9afd29597e692c4924a12ed42f970537c72cc0f",
  "windows_x32.zip": "190ad53db301eec3e90afe3a1a75270768b8ebf89e731345e19421c32c1ae1a1",
  "windows_x64.zip": "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e",
};

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const VENDOR_DIR = join(PACKAGE_ROOT, "vendor");

/** Release-asset suffix (e.g. `darwin_arm64.tar.gz`) for a platform, or null when gitleaks publishes none. */
export function assetSuffix(platform = process.platform, arch = process.arch, armVersion = process.config?.variables?.arm_version) {
  if (platform === "darwin") return arch === "arm64" ? "darwin_arm64.tar.gz" : arch === "x64" ? "darwin_x64.tar.gz" : null;
  if (platform === "linux") {
    if (arch === "x64") return "linux_x64.tar.gz";
    if (arch === "arm64") return "linux_arm64.tar.gz";
    if (arch === "ia32") return "linux_x32.tar.gz";
    if (arch === "arm") return String(armVersion) === "6" ? "linux_armv6.tar.gz" : "linux_armv7.tar.gz";
    return null;
  }
  if (platform === "win32") return arch === "x64" ? "windows_x64.zip" : arch === "arm64" ? "windows_arm64.zip" : arch === "ia32" ? "windows_x32.zip" : null;
  return null;
}

export function binaryName(platform = process.platform) {
  return platform === "win32" ? "gitleaks.exe" : "gitleaks";
}

export function downloadUrl(suffix, version = GITLEAKS_VERSION) {
  return `https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_${suffix}`;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Throws unless the buffer matches the pinned hash for this asset. */
export function verifyArchive(buffer, suffix, pinned = GITLEAKS_SHA256) {
  const expected = pinned[suffix];
  if (!expected) throw new Error(`no pinned checksum for ${suffix}`);
  const actual = sha256(buffer);
  if (actual !== expected) throw new Error(`checksum mismatch for ${suffix} (expected ${expected}, got ${actual}); refusing to install`);
}

async function installedVersion(path) {
  try {
    const { stdout } = await execFileAsync(path, ["version"], { timeout: 15_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Download, verify, extract and install. Returns the binary path.
 * `fetchImpl` and `vendorDir` are injectable for tests.
 */
export async function installGitleaks({ fetchImpl = fetch, vendorDir = VENDOR_DIR, platform = process.platform, arch = process.arch, log = console.log, pinned = GITLEAKS_SHA256 } = {}) {
  const suffix = assetSuffix(platform, arch);
  if (suffix === null) throw new Error(`gitleaks publishes no build for ${platform}/${arch}`);
  const target = join(vendorDir, binaryName(platform));

  if ((await installedVersion(target))?.includes(GITLEAKS_VERSION)) return { path: target, alreadyInstalled: true };

  log(`checkin: downloading gitleaks ${GITLEAKS_VERSION} (${suffix})…`);
  const response = await fetchImpl(downloadUrl(suffix), { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  verifyArchive(archive, suffix, pinned);

  const work = await mkdtemp(join(tmpdir(), "checkin-gitleaks-"));
  try {
    const archivePath = join(work, `gitleaks-${suffix}`);
    await writeFile(archivePath, archive);
    // bsdtar/GNU tar read .tar.gz; Windows' bundled bsdtar also reads .zip.
    await execFileAsync("tar", ["-xf", archivePath, "-C", work], { timeout: 60_000 });
    await mkdir(vendorDir, { recursive: true });
    await copyFile(join(work, binaryName(platform)), target);
    if (platform !== "win32") await chmod(target, 0o755);
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  const version = await installedVersion(target);
  if (!version?.includes(GITLEAKS_VERSION)) {
    await rm(target, { force: true });
    throw new Error(`the installed binary did not report version ${GITLEAKS_VERSION} (got ${JSON.stringify(version)})`);
  }
  return { path: target, alreadyInstalled: false };
}

async function main() {
  if (process.env.CHECKIN_SKIP_GITLEAKS_DOWNLOAD === "1") {
    console.log("checkin: skipping gitleaks download (CHECKIN_SKIP_GITLEAKS_DOWNLOAD=1).");
    return;
  }
  try {
    const result = await installGitleaks();
    console.log(result.alreadyInstalled ? `checkin: gitleaks ${GITLEAKS_VERSION} already installed.` : `checkin: installed gitleaks ${GITLEAKS_VERSION} at ${result.path}`);
  } catch (e) {
    console.warn(
      `checkin: could not install gitleaks (${e instanceof Error ? e.message : String(e)}).\n` +
        "         Secret scanning will use a `gitleaks` on your PATH if you install one (e.g. `brew install gitleaks`),\n" +
        "         or retry with `npm run install-gitleaks` from the package directory.",
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

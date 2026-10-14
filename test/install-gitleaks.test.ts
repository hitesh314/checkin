import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GITLEAKS_SHA256,
  GITLEAKS_VERSION,
  assetSuffix,
  binaryName,
  downloadUrl,
  installGitleaks,
  sha256,
  verifyArchive,
} from "../scripts/install-gitleaks.mjs";
import { bundledGitleaksPath, createGitleaksScanner, resolveGitleaksCommand } from "../src/scan/gitleaks.js";
import { createRepo, makeTempDir } from "./helpers/repo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("gitleaks installer", () => {
  it("maps platforms to release assets", () => {
    expect(assetSuffix("darwin", "arm64")).toBe("darwin_arm64.tar.gz");
    expect(assetSuffix("darwin", "x64")).toBe("darwin_x64.tar.gz");
    expect(assetSuffix("linux", "x64")).toBe("linux_x64.tar.gz");
    expect(assetSuffix("linux", "arm64")).toBe("linux_arm64.tar.gz");
    expect(assetSuffix("linux", "arm", "6")).toBe("linux_armv6.tar.gz");
    expect(assetSuffix("linux", "arm", "7")).toBe("linux_armv7.tar.gz");
    expect(assetSuffix("win32", "x64")).toBe("windows_x64.zip");
    expect(assetSuffix("freebsd", "x64")).toBeNull();
    expect(assetSuffix("linux", "riscv64")).toBeNull();
    expect(binaryName("win32")).toBe("gitleaks.exe");
    expect(binaryName("darwin")).toBe("gitleaks");
  });

  it("pins a SHA-256 for every asset it can select, and downloads only from the gitleaks GitHub releases", () => {
    const combos: Array<[string, string, string?]> = [
      ["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["linux", "arm64"], ["linux", "ia32"],
      ["linux", "arm", "6"], ["linux", "arm", "7"], ["win32", "x64"], ["win32", "arm64"], ["win32", "ia32"],
    ];
    for (const [p, a, v] of combos) {
      const suffix = assetSuffix(p, a, v)!;
      expect(GITLEAKS_SHA256[suffix], suffix).toMatch(/^[0-9a-f]{64}$/);
      expect(downloadUrl(suffix)).toBe(`https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${suffix}`);
    }
  });

  it("verifies archives against the pinned hash", () => {
    const data = Buffer.from("archive bytes");
    expect(() => verifyArchive(data, "linux_x64.tar.gz", { "linux_x64.tar.gz": sha256(data) })).not.toThrow();
    expect(() => verifyArchive(data, "linux_x64.tar.gz", { "linux_x64.tar.gz": "0".repeat(64) })).toThrow(/checksum mismatch/);
    expect(() => verifyArchive(data, "linux_x64.tar.gz", {})).toThrow(/no pinned checksum/);
  });

  // A tiny tar.gz holding a script that reports the pinned version, served by a fake fetch.
  function fakeRelease(version: string): { archive: Buffer; suffix: string } {
    const src = makeTempDir("fake-release-");
    writeFileSync(join(src, "gitleaks"), `#!/bin/sh\necho ${version}\n`);
    chmodSync(join(src, "gitleaks"), 0o755);
    const out = join(src, "a.tar.gz");
    execFileSync("tar", ["-czf", out, "-C", src, "gitleaks"]);
    return { archive: readFileSync(out), suffix: "linux_x64.tar.gz" };
  }
  const onPosix = process.platform !== "win32";

  it.skipIf(!onPosix)("downloads, verifies, extracts and installs, then reuses the installed copy", async () => {
    const { archive, suffix } = fakeRelease(GITLEAKS_VERSION);
    const vendorDir = join(makeTempDir("vendor-"), "vendor");
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(new Uint8Array(archive), { status: 200 });
    }) as unknown as typeof fetch;
    const options = { fetchImpl, vendorDir, platform: "linux", arch: "x64", log: () => undefined, pinned: { [suffix]: sha256(archive) } };

    const first = await installGitleaks(options);
    expect(first).toEqual({ path: join(vendorDir, "gitleaks"), alreadyInstalled: false });
    expect(execFileSync(first.path, ["version"], { encoding: "utf8" }).trim()).toBe(GITLEAKS_VERSION);
    expect(urls).toEqual([downloadUrl(suffix)]);

    const second = await installGitleaks(options);
    expect(second.alreadyInstalled).toBe(true);
    expect(urls).toHaveLength(1);
  });

  it.skipIf(!onPosix)("refuses a tampered download and installs nothing", async () => {
    const { archive, suffix } = fakeRelease(GITLEAKS_VERSION);
    const vendorDir = join(makeTempDir("vendor-"), "vendor");
    const fetchImpl = (async () => new Response(new Uint8Array(archive), { status: 200 })) as unknown as typeof fetch;
    await expect(
      installGitleaks({ fetchImpl, vendorDir, platform: "linux", arch: "x64", log: () => undefined, pinned: { [suffix]: "f".repeat(64) } }),
    ).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(join(vendorDir, "gitleaks"))).toBe(false);
  });

  it.skipIf(!onPosix)("rejects a binary that does not report the pinned version, and removes it", async () => {
    const { archive, suffix } = fakeRelease("1.0.0");
    const vendorDir = join(makeTempDir("vendor-"), "vendor");
    const fetchImpl = (async () => new Response(new Uint8Array(archive), { status: 200 })) as unknown as typeof fetch;
    await expect(
      installGitleaks({ fetchImpl, vendorDir, platform: "linux", arch: "x64", log: () => undefined, pinned: { [suffix]: sha256(archive) } }),
    ).rejects.toThrow(/did not report version/);
    expect(existsSync(join(vendorDir, "gitleaks"))).toBe(false);
  });

  it("fails clearly on HTTP errors and unsupported platforms", async () => {
    const vendorDir = join(makeTempDir("vendor-"), "vendor");
    const notFound = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(installGitleaks({ fetchImpl: notFound, vendorDir, platform: "linux", arch: "x64", log: () => undefined })).rejects.toThrow(/HTTP 404/);
    await expect(installGitleaks({ vendorDir, platform: "freebsd", arch: "x64", log: () => undefined })).rejects.toThrow(/no build for freebsd/);
  });

  it("the postinstall script never fails npm install, even when the download is impossible", () => {
    const script = join(__dirname, "..", "scripts", "install-gitleaks.mjs");
    const out = execFileSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CHECKIN_SKIP_GITLEAKS_DOWNLOAD: "1" } });
    expect(out).toContain("skipping gitleaks download");
  });
});

describe("choosing which gitleaks to run", () => {
  it("prefers an explicit path, then the copy installed with checkin, then PATH", () => {
    const yes = () => true;
    const no = () => false;
    expect(resolveGitleaksCommand({ CHECKIN_GITLEAKS_PATH: " /opt/gl " }, "/pkg/vendor/gitleaks", yes)).toEqual({ command: "/opt/gl", source: "CHECKIN_GITLEAKS_PATH" });
    expect(resolveGitleaksCommand({}, "/pkg/vendor/gitleaks", yes)).toEqual({ command: "/pkg/vendor/gitleaks", source: "bundled" });
    expect(resolveGitleaksCommand({}, "/pkg/vendor/gitleaks", no)).toEqual({ command: "gitleaks", source: "PATH" });
  });

  it("looks for the bundled binary inside this package's vendor directory", () => {
    expect(bundledGitleaksPath("linux")).toBe(join(__dirname, "..", "vendor", "gitleaks"));
    expect(bundledGitleaksPath("win32")).toBe(join(__dirname, "..", "vendor", "gitleaks.exe"));
  });
});

// Runs only when the real binary was installed by `npm install` / `npm run install-gitleaks`.
describe.skipIf(!existsSync(bundledGitleaksPath()))("the real bundled gitleaks", () => {
  const scanner = createGitleaksScanner({ command: bundledGitleaksPath() });
  const FAKE_TOKEN = `ghp_${"aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5".slice(0, 36)}`;

  function stage(repo: ReturnType<typeof createRepo>, path: string, content: string): void {
    repo.write(path, content);
    repo.git("add", path);
  }

  it("reports a clean staged change as clean", async () => {
    const repo = createRepo();
    stage(repo, "hello.txt", "just some text\n");
    const result = await scanner.scanStaged(repo.dir);
    expect(result).toMatchObject({ status: "clean", version: GITLEAKS_VERSION });
  });

  it("finds a staged secret and reports only rule, file and line", async () => {
    const repo = createRepo();
    stage(repo, "src/deploy.ts", `export const token = "${FAKE_TOKEN}";\n`);
    const result = await scanner.scanStaged(repo.dir);
    expect(result.status).toBe("findings");
    if (result.status !== "findings") return;
    expect(result.findings[0]).toMatchObject({ file: "src/deploy.ts", line: 1 });
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });

  it("ignores secrets that are not staged, and works in a repo with no commits", async () => {
    const repo = createRepo({ commit: false });
    repo.write("untracked.ts", `const t = "${FAKE_TOKEN}";\n`);
    stage(repo, "ok.txt", "fine\n");
    expect(await scanner.scanStaged(repo.dir)).toMatchObject({ status: "clean" });
  });

  it("honours an inline gitleaks:allow comment", async () => {
    const repo = createRepo();
    stage(repo, "a.ts", `const t = "${FAKE_TOKEN}"; // gitleaks:allow\n`);
    expect(await scanner.scanStaged(repo.dir)).toMatchObject({ status: "clean" });
  });
});

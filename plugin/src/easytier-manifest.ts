// Pinned EasyTier release assets.
//
// Every asset's SHA-256 was computed from the file GitHub serves for
// EasyTier/EasyTier v2.6.4 (commit 8428a89d2dabc94c97d370ec607c6ca142473626) on
// 2026-10-30. The supervisor refuses an unlisted platform or a hash mismatch: it
// never runs an unverified binary.
//
// Sources: https://github.com/EasyTier/EasyTier/releases/tag/v2.6.4

export const EASYTIER_VERSION = "2.6.4";
export const EASYTIER_COMMIT = "8428a89d2dabc94c97d370ec607c6ca142473626";
export const EASYTIER_RELEASE_URL = `https://github.com/EasyTier/EasyTier/releases/download/v${EASYTIER_VERSION}`;

export interface Asset {
  /** release asset file name */
  file: string;
  /** sha256 of the downloaded zip */
  sha256: string;
  /** folder inside the zip holding the binaries */
  dir: string;
  /** binary names */
  core: string;
  cli: string;
}

const table: Record<string, Asset> = {
  "darwin-arm64": {
    file: "easytier-macos-aarch64-v2.6.4.zip",
    sha256: "4be1882d1aa36d31c1d6ba0596f2cf8a097e371f8da124212324b2e0f8df7e4b",
    dir: "easytier-macos-aarch64",
    core: "easytier-core",
    cli: "easytier-cli",
  },
  "darwin-x64": {
    file: "easytier-macos-x86_64-v2.6.4.zip",
    sha256: "89fc28a6e6995259d76ce3f11775220e8a21c760e94df91a6a9db30a69b6982e",
    dir: "easytier-macos-x86_64",
    core: "easytier-core",
    cli: "easytier-cli",
  },
  "linux-x64": {
    file: "easytier-linux-x86_64-v2.6.4.zip",
    sha256: "61b659eaedba658fa66fe47d17e1426cdd77e5d02fa15fed447bb4357c09dfd6",
    dir: "easytier-linux-x86_64",
    core: "easytier-core",
    cli: "easytier-cli",
  },
  "linux-arm64": {
    file: "easytier-linux-aarch64-v2.6.4.zip",
    sha256: "f533ec25a7ea714e09f645615012200278058525795cc3bb690ff011aec1a70f",
    dir: "easytier-linux-aarch64",
    core: "easytier-core",
    cli: "easytier-cli",
  },
  "win32-x64": {
    file: "easytier-windows-x86_64-v2.6.4.zip",
    sha256: "27af91e270e554709b048bd32327fefd2dfce5062ae1e8701af7550c6f525f84",
    dir: "easytier-windows-x86_64",
    core: "easytier-core.exe",
    cli: "easytier-cli.exe",
  },
};

export function assetFor(platform: string = process.platform, arch: string = process.arch): Asset {
  const key = `${platform}-${arch}`;
  const a = table[key];
  if (!a) {
    throw new Error(
      `EasyTier ${EASYTIER_VERSION}: no verified build for ${key}. ` +
        `Verified: ${Object.keys(table).join(", ")}. ` +
        `Place a verified easytier-core/easytier-cli in the plugin's state directory or report the platform.`,
    );
  }
  return a;
}

export function assetUrl(a: Asset): string {
  return `${EASYTIER_RELEASE_URL}/${a.file}`;
}

export function allAssets(): Record<string, Asset> {
  return table;
}

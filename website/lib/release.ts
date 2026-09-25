/**
 * The release the site falls back to when it cannot ask GitHub for the latest
 * published one (lib/latestRelease.ts). `scripts/bump-version.mjs` sets it, and
 * /latest.json answers with it.
 */
export const VERSION = "0.4.0";

const BASE = "https://github.com/MiguelMedeiros/ghostly/releases";

/** Every release, for the footer. */
export const RELEASES_URL = BASE;

/** One release's page. */
export const releaseUrl = (version: string) => `${BASE}/tag/v${version}`;

/** The installers' file names in a release, as the release workflow names them. */
export const assetNames = (version: string) => ({
  macArm: `Ghostly_${version}_aarch64.dmg`,
  macIntel: `Ghostly_${version}_x64.dmg`,
  windowsExe: `Ghostly_${version}_x64-setup.exe`,
  windowsMsi: `Ghostly_${version}_x64_en-US.msi`,
  linuxDeb: `Ghostly_${version}_amd64.deb`,
  linuxAppImage: `Ghostly_${version}_amd64.AppImage`,
  extensionZip: `ghostly-browser-extension-${version}.zip`,
});

/** Every download link of one release, plus the extension's Chrome Web Store page. */
export function downloads(version: string) {
  const names = assetNames(version);
  const asset = (key: keyof typeof names) => `${BASE}/download/v${version}/${names[key]}`;
  return {
    macArm: asset("macArm"),
    macIntel: asset("macIntel"),
    windowsExe: asset("windowsExe"),
    windowsMsi: asset("windowsMsi"),
    linuxDeb: asset("linuxDeb"),
    linuxAppImage: asset("linuxAppImage"),
    extensionZip: asset("extensionZip"),
    /** The browser extension, published on the Chrome Web Store (item nbedaagicniejlmfcncndfjcejaidbcf). */
    chromeStore: "https://chromewebstore.google.com/detail/ghostly/nbedaagicniejlmfcncndfjcejaidbcf",
  };
}

/** The release the site offers, for the finale. */
export const RELEASE_URL = releaseUrl(VERSION);

export const DOWNLOADS = downloads(VERSION);

/** The installer a download strip should lead with. */
export type InstallerKey = "macArm" | "macIntel" | "windowsExe" | "linuxDeb" | "linuxAppImage";

/**
 * Maps a browser's userAgent and platform strings to the installer most people
 * on that machine want. Pure, so it can be unit-tested and called during
 * hydration; `undefined` means "we cannot tell, show every platform".
 *
 * Apple silicon Macs report an Intel userAgent, so we only pick Intel when the
 * caller passes a hint (`navigator.platform` never reveals the architecture;
 * the WebGL renderer or `userAgentData` would). Without one, Apple silicon is
 * the default Mac since every Mac sold since 2020 is one.
 */
export function defaultInstaller(userAgent: string, platform = "", arch?: string): InstallerKey | undefined {
  const ua = userAgent.toLowerCase();
  const pf = platform.toLowerCase();
  const isPhone = /iphone|ipad|ipod|android/.test(ua);
  if (isPhone) return undefined;
  if (/windows/.test(ua) || pf.startsWith("win")) return "windowsExe";
  if (/macintosh|mac os x/.test(ua) || pf.startsWith("mac")) {
    if (arch && /x86|intel|x64|amd64/i.test(arch)) return "macIntel";
    return "macArm";
  }
  if (/linux|x11|cros/.test(ua) || pf.startsWith("linux")) {
    if (/ubuntu|debian|mint|pop!_os|elementary/.test(ua)) return "linuxDeb";
    return "linuxAppImage";
  }
  return undefined;
}

export type DownloadKey = keyof typeof DOWNLOADS;
/** The desktop installers: every download except the browser extension. */
export type DesktopKey = Exclude<DownloadKey, "extensionZip" | "chromeStore">;
export type PlatformId = "mac" | "windows" | "linux";

/** The three desktop platforms, each with its installers in the order a download panel lists them. */
export const PLATFORMS: { id: PlatformId; installers: { key: DesktopKey; ext: string }[] }[] = [
  {
    id: "mac",
    installers: [
      { key: "macArm", ext: ".dmg" },
      { key: "macIntel", ext: ".dmg" },
    ],
  },
  {
    id: "windows",
    installers: [
      { key: "windowsExe", ext: ".exe" },
      { key: "windowsMsi", ext: ".msi" },
    ],
  },
  {
    id: "linux",
    installers: [
      { key: "linuxDeb", ext: ".deb" },
      { key: "linuxAppImage", ext: ".AppImage" },
    ],
  },
];

/** The platform an installer belongs to, so a panel can lead with the detected machine's card. */
export function platformOf(key: InstallerKey): PlatformId {
  if (key.startsWith("mac")) return "mac";
  if (key.startsWith("windows")) return "windows";
  return "linux";
}

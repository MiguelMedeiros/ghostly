/**
 * The release the site offers for download. `scripts/bump-version.mjs` sets it;
 * every download link on the site is built from here.
 */
export const VERSION = "0.4.0";

const BASE = "https://github.com/MiguelMedeiros/ghostly/releases";

/** Every release, for the footer. */
export const RELEASES_URL = BASE;

/** The release the site offers, for the finale. */
export const RELEASE_URL = `${BASE}/tag/v${VERSION}`;

const asset = (name: string) => `${BASE}/download/v${VERSION}/${name}`;

export const DOWNLOADS = {
  macArm: asset(`Ghostly_${VERSION}_aarch64.dmg`),
  macIntel: asset(`Ghostly_${VERSION}_x64.dmg`),
  windowsExe: asset(`Ghostly_${VERSION}_x64-setup.exe`),
  windowsMsi: asset(`Ghostly_${VERSION}_x64_en-US.msi`),
  linuxDeb: asset(`Ghostly_${VERSION}_amd64.deb`),
  linuxAppImage: asset(`Ghostly_${VERSION}_amd64.AppImage`),
  extensionZip: asset(`ghostly-browser-extension-${VERSION}.zip`),
} as const;

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
export type DesktopKey = Exclude<DownloadKey, "extensionZip">;
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

/**
 * The release the site offers for download. `scripts/bump-version.mjs` sets it;
 * every download link on the site is built from here.
 */
export const VERSION = "0.3.4";

const BASE = "https://github.com/MiguelMedeiros/ghostly/releases";

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

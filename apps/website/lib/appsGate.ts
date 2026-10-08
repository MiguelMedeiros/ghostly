import { latestRelease } from "./latestRelease";
import { VERSION } from "./release";

/**
 * Whether the site shows Apps at all: only once the released Ghostly has them (1.2), by the release the download panel
 * offers (lib/latestRelease.ts). Before that the pages are not found and nothing links to them.
 *
 * A test build (GHOSTLY_STORE_FIXTURE, which CI sets) never asks GitHub: it reads VERSION (lib/release.ts), so its
 * pages and its browser checks agree whatever GitHub's latest release is. There, and only there, GHOSTLY_SITE_RELEASE
 * stands in for the release (e2e/apps-pages.spec.ts serves one build as 1.1 and as 1.2). A production build has neither,
 * so a stray GHOSTLY_SITE_RELEASE on the host opens nothing.
 */
export async function appsReleased(): Promise<boolean> {
  return versionAtLeast(await siteRelease(), APPS_RELEASE);
}

async function siteRelease(): Promise<string> {
  if (process.env.GHOSTLY_STORE_FIXTURE) return process.env.GHOSTLY_SITE_RELEASE || VERSION;
  return latestRelease();
}

/** `a` is `b` or later, by numbers (1.10.0 is later than 1.2.0). A version that is not x.y.z is never later. */
export function versionAtLeast(a: string, b: string): boolean {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}

/**
 * The first release that has Apps (WISP 1200: phase 1 is release 1.2). Before it, the site shows nothing of them. The
 * same as the APPS_ENABLED guard's `from` in tools/scripts/changes.mjs (packages/browser/test/websiteStore.test.ts).
 */
export const APPS_RELEASE = "1.2.0";

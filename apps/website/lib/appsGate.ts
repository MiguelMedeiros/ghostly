import { latestRelease } from "./latestRelease";

/**
 * Whether the site shows Apps at all: only once the released Ghostly has them (1.2), by the release the download panel
 * offers (lib/latestRelease.ts). Before that the pages are not found and nothing links to them.
 *
 * GHOSTLY_SITE_RELEASE stands in for the release in the site's own browser checks (e2e/apps-pages.spec.ts); nothing
 * else sets it.
 */
export async function appsReleased(): Promise<boolean> {
  const release = process.env.GHOSTLY_SITE_RELEASE || (await latestRelease());
  return versionAtLeast(release, APPS_RELEASE);
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

/** The first release that has Apps (WISP 1200: phase 1 is release 1.2). Before it, the site shows nothing of them. */
export const APPS_RELEASE = "1.2.0";

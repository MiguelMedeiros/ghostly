import { expect, openPeer, test, type Peer } from "../support/fixtures";

/** A release the compatibility config serves beside the current app (playwright.compat.config.ts). */
export type Release = string;

/** The newest release, which the config reads from the tags (tools/scripts/compat-latest-release.mjs). */
export const latestRelease: Release = (process.env.E2E_COMPAT_LATEST ?? "").replace(/^v/, "");

/** A peer on that release's own build. */
export async function oldPeer(browser: Parameters<typeof openPeer>[0], relay: Parameters<typeof openPeer>[1], release: Release, name: string): Promise<Peer> {
  const url = (test.info().config.metadata.releases as Record<Release, string>)[release];
  const peer = await openPeer(browser, relay, url, name);
  // The old app is the one we think it is.
  expect(await peer.page.evaluate(async () => (await (await fetch("/version.json")).json()) as { version: string })).toMatchObject({ version: release });
  return peer;
}

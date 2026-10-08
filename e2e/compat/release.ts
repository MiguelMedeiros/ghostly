import { expect, openPeer, test, type Peer } from "../support/fixtures";

/** A v1.1.x release the compatibility config serves beside the current app (playwright.compat.config.ts). */
export type Release = "1.1.4" | "1.1.5";

/** A peer on that release's own build. */
export async function oldPeer(browser: Parameters<typeof openPeer>[0], relay: Parameters<typeof openPeer>[1], release: Release, name: string): Promise<Peer> {
  const url = (test.info().config.metadata.releases as Record<Release, string>)[release];
  const peer = await openPeer(browser, relay, url, name);
  // The old app is the one we think it is.
  expect(await peer.page.evaluate(async () => (await (await fetch("/version.json")).json()) as { version: string })).toMatchObject({ version: release });
  return peer;
}

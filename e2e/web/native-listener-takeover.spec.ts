import type { BrowserContext } from "@playwright/test";
import { endpoints } from "../infra/env.mjs";
import { chat, expect, link, say, test, type Peer } from "../support/fixtures";

// Two apps with more chats between them than native listeners (eight per transport), one with no WebRTC at all, as the
// Desktop on Linux: their chats go over Iroh only, and every listener carries a live session. A chat made now goes live
// too, once the session it takes a listener from has been quiet for two minutes (#1006: chat ten stayed "On DHT ·
// retrying live" for as long as the others were live, since an app never took a listener from a live session).
test.skip(!process.env.GHOSTLY_IROH_RELAY_URL, "Needs the e2e infra's Iroh relay (npm run e2e:infra:use)");

/** More than the eight native listeners an app holds per transport. */
const OTHER_CHATS = 9;
/** How long a live session goes unused before a chat in use may take its listener (`NATIVE_HOLD_MS`). */
const HOLD_MS = 2 * 60_000;
/** The new chat, opened on both sides, is live over Iroh within this. */
const LIVE_MS = 60_000;

/** A page with no WebRTC at all: `RTCPeerConnection` is not there, as in WebKitGTK. */
async function noWebRtc(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCSessionDescription", "RTCIceCandidate"])
      delete (window as unknown as Record<string, unknown>)[name];
  });
}

const onIroh = (peer: Peer, timeout: number) =>
  expect(peer.page.getByTestId("connection-options")).toHaveAttribute("data-transport", "iroh/1", { timeout });

test("a chat made while every native listener is live takes the one of a quiet chat, and goes live", {
  tag: ["@feature:transport.native-pool", "@feature:transport.iroh-web"],
}, async ({ peer }) => {
  test.setTimeout(15 * 60_000);
  const relay = endpoints.irohRelay;
  const [linux, web] = await Promise.all([peer("linux", { irohRelay: relay, beforeOpen: noWebRtc }), peer("web", { irohRelay: relay })]);
  expect(await linux.page.evaluate(() => typeof (window as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection)).toBe("undefined");

  // The chats made before, each live over Iroh: the first eight take every listener on the Linux side. The ninth may
  // take the first one's, once that has been quiet long enough.
  const usedAt: number[] = [];
  for (let i = 0; i < OTHER_CHATS; i++) {
    await link(web, linux);
    await say(linux, `chat ${i}`);
    await expect(chat(web).getByText(`chat ${i}`)).toBeVisible({ timeout: 60_000 });
    if (i < 8) await onIroh(linux, 120_000);
    usedAt.push(Date.now());
  }
  // The second is quiet for long enough by now, or soon (the first may have gone to the ninth).
  const wait = usedAt[1] + HOLD_MS - Date.now();
  if (wait > 0) await linux.page.waitForTimeout(wait);

  // A new chat, on screen on both sides: it takes the quiet chat's listener on each, and goes live over Iroh.
  const started = Date.now();
  await link(linux, web);
  await Promise.all([onIroh(linux, LIVE_MS), onIroh(web, LIVE_MS)]);
  console.log(`[native-listener-takeover] the new chat is live over Iroh in ${Date.now() - started} ms`);
  await say(web, "live at last");
  await expect(chat(linux).getByText("live at last")).toBeVisible({ timeout: 30_000 });
});

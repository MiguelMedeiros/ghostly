import type { BrowserContext } from "@playwright/test";
import { endpoints } from "../infra/env.mjs";
import { chat, expect, link, say, test, type Peer } from "../support/fixtures";

// Two apps with more chats between them than native listeners (eight per transport), one with no WebRTC at all, as the
// Desktop on Linux: their chats go over Iroh only. Both restart (reload, then close and open again), and the chat they
// were just live in is live again (Omarchy, 2026-09-30: it stayed "On DHT · retrying live" for minutes, because the
// chats stored before it took every listener on one side, and its contact dialled a listener that was not there).
test.skip(!process.env.GHOSTLY_IROH_RELAY_URL, "Needs the e2e infra's Iroh relay (npm run e2e:infra:use)");

/** More than the eight native listeners an app holds per transport. */
const OTHER_CHATS = 9;
const LIVE_AGAIN_MS = 60_000;

/** A page with no WebRTC at all: `RTCPeerConnection` is not there, as in WebKitGTK. */
async function noWebRtc(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCSessionDescription", "RTCIceCandidate"])
      delete (window as unknown as Record<string, unknown>)[name];
  });
}

const onIroh = (peer: Peer, timeout: number) =>
  expect(peer.page.getByTestId("connection-options")).toHaveAttribute("data-transport", "iroh/1", { timeout });

test("a chat live before both apps restart is live again, with more chats between them than native listeners", {
  tag: ["@feature:chat.paired.reconnect", "@feature:transport.iroh-web", "@feature:transport.native-pool"],
}, async ({ peer }) => {
  test.setTimeout(12 * 60_000);
  const relay = endpoints.irohRelay;
  const [linux, web] = await Promise.all([peer("linux", { irohRelay: relay, beforeOpen: noWebRtc }), peer("web", { irohRelay: relay })]);
  expect(await linux.page.evaluate(() => typeof (window as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection)).toBe("undefined");

  // The chats made before, each paired.
  for (let i = 0; i < OTHER_CHATS; i++) {
    await link(web, linux);
    await say(linux, `chat ${i}`);
    await expect(chat(web).getByText(`chat ${i}`)).toBeVisible({ timeout: 60_000 });
  }
  // The one they talk in now, live over Iroh on both sides.
  await link(linux, web);
  await say(web, "hello over Iroh");
  await expect(chat(linux).getByText("hello over Iroh")).toBeVisible({ timeout: 60_000 });
  await Promise.all([onIroh(linux, 120_000), onIroh(web, 120_000)]);
  const urls = new Map([linux, web].map(p => [p, p.page.url()] as const));

  for (const how of ["reload", "reopen"] as const) {
    const started = Date.now();
    if (how === "reload") await Promise.all([linux, web].map(p => p.page.reload()));
    else await Promise.all([linux, web].map(async p => {
      await p.page.close();
      p.page = await p.context.newPage();
      await p.page.goto(urls.get(p)!);
    }));
    await Promise.all([onIroh(linux, LIVE_AGAIN_MS), onIroh(web, LIVE_AGAIN_MS)]);
    console.log(`[restart-both-native] ${how}: live again on both sides in ${Date.now() - started} ms`);
    await say(linux, `back after a ${how}`);
    await expect(chat(web).getByText(`back after a ${how}`)).toBeVisible({ timeout: 30_000 });
  }
});

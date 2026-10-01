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

  // The one they talk in, live over Iroh on both sides. Made first: an app never takes a native listener from a chat
  // whose session is live, so a chat made while eight others are live over Iroh stays on the DHT until one of them
  // ends (the CI full runs on 2072fff1: chat ten, made last, never went live).
  await link(linux, web);
  await say(web, "hello over Iroh");
  await expect(chat(linux).getByText("hello over Iroh")).toBeVisible({ timeout: 60_000 });
  await Promise.all([onIroh(linux, 120_000), onIroh(web, 120_000)]);
  const urls = new Map([linux, web].map(p => [p, p.page.url()] as const));

  // The other chats, each paired: they take the listeners left, and the last ones find none.
  for (let i = 0; i < OTHER_CHATS; i++) {
    await link(web, linux);
    await say(linux, `chat ${i}`);
    await expect(chat(web).getByText(`chat ${i}`)).toBeVisible({ timeout: 60_000 });
  }
  // Back to the chat they talk in, still live, and written in last.
  for (const p of [linux, web]) await p.page.evaluate((hash) => { location.hash = hash; }, new URL(urls.get(p)!).hash);
  await expect(chat(linux).getByText("hello over Iroh")).toBeVisible();
  await Promise.all([onIroh(linux, 30_000), onIroh(web, 30_000)]);
  await say(web, "still here");
  await expect(chat(linux).getByText("still here")).toBeVisible({ timeout: 30_000 });

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

// Both close, the web app is back first and knocks on the other app, which is not there; that app is back 30 s later
// and knocks in turn (Omarchy, 2026-10-01: live 34.6 s after the Desktop started, against 5-14 s the other ways round).
const WEB_FIRST_LIVE_MS = 20_000;

test("a chat live before both apps close is live again soon when the web app is back first", {
  tag: ["@feature:chat.paired.reconnect", "@feature:transport.iroh-web"],
}, async ({ peer }) => {
  test.setTimeout(6 * 60_000);
  const relay = endpoints.irohRelay;
  const [linux, web] = await Promise.all([peer("linux", { irohRelay: relay, beforeOpen: noWebRtc }), peer("web", { irohRelay: relay })]);
  await link(linux, web);
  await say(web, "hello over Iroh");
  await expect(chat(linux).getByText("hello over Iroh")).toBeVisible({ timeout: 60_000 });
  await Promise.all([onIroh(linux, 120_000), onIroh(web, 120_000)]);
  const urls = new Map([linux, web].map(p => [p, p.page.url()] as const));

  await Promise.all([linux, web].map(p => p.page.close()));
  const reopen = async (p: Peer) => { p.page = await p.context.newPage(); await p.page.goto(urls.get(p)!); };
  await reopen(web);
  await web.page.waitForTimeout(30_000);
  const started = Date.now();
  await reopen(linux);
  await Promise.all([onIroh(linux, WEB_FIRST_LIVE_MS), onIroh(web, WEB_FIRST_LIVE_MS)]);
  console.log(`[restart-both-native] web first: live again on both sides ${Date.now() - started} ms after the other app opened`);
  await say(linux, "back, web first");
  await expect(chat(web).getByText("back, web first")).toBeVisible({ timeout: 30_000 });
});

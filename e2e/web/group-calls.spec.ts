import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { Page } from "@playwright/test";
import { endpoints } from "../infra/env.mjs";
import { expect, test, type Peer } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * A community group's call through its node (WISP 602), end to end: a headless Ghostly is the group's admin, as the
 * node is, and names the e2e stack's token mock as the group's SFU (`ghostly group call --sfu`). Three browsers join
 * by the link and press Join call: each asks the mock for a pass with a request its member key signs, and all three
 * meet in the stack's LiveKit room. They see each other's tiles, a mute shows on the others, one shares the screen
 * (Chromium's fake one, picked by --auto-select-desktop-capture-source) and the other two get it, and a leave takes the
 * tile away. A fourth browser in the group but not in the node's roster gets no pass and sees why.
 *
 * The mock answers for GHOSTLY_SFU_ORIGIN, a name nothing resolves: each browser's requests to it go to the mock's port.
 */
test.skip(!process.env.GHOSTLY_SFU_URL, "Needs the e2e infra's LiveKit and group-token mock (npm run e2e:infra:use)");
test.describe.configure({ timeout: 10 * 60_000 });

const REFUSED = "You're not let into this call yet";

const tile = (peer: Peer, identity: string, kind: "face" | "screen") =>
  peer.page.locator(`[data-testid="group-call-tile"][data-identity="${identity}"][data-kind="${kind}"]`);

/** The tile's video plays: a picture with a size, and its time moving on. */
async function plays(peer: Peer, identity: string, kind: "face" | "screen"): Promise<void> {
  const video = tile(peer, identity, kind).locator("video");
  await expect(video).toHaveCount(1, { timeout: 30_000 });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 }).toBeGreaterThan(0);
  const at = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(at);
}

/** The group's SFU origin, as the group names it, reaches the e2e stack's token mock from this browser. */
async function routeSfu(peer: Peer): Promise<void> {
  await peer.context.route(`${endpoints.sfu.origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${endpoints.sfu.token}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
}

async function joinGroup(peer: Peer, link: string): Promise<void> {
  await peer.page.goto(link.includes("#") ? "/" + link.slice(link.indexOf("#")) : `/#/join/${link}`);
  await expect(peer.page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 180_000 });
}

test("three members join a community group's call, see and hear each other, see a shared screen; an outsider gets no pass", { tag: ["@feature:calls.group", "@feature:calls.group.room", "@feature:calls.group.screen"] }, async ({ peer, relay }, testInfo) => {
  const started = Date.now();
  const node = new HeadlessBot();
  try {
    await node.start(await relay.listen(), "Thursday node");
    const group = (await node.run("group", "create", "Thursday")).group as string;
    await node.run("group", "call", group, "--sfu", endpoints.sfu.origin);
    const link = (await node.run("group", "link", group)).link as string;

    const [ana, bia, cleo, dan] = await Promise.all(["Ana", "Bia", "Cleo", "Dan"].map((name) => peer(name)));
    for (const p of [ana, bia, cleo, dan]) await routeSfu(p);
    const callers = [ana, bia, cleo];
    await Promise.all(callers.map((p) => joinGroup(p, link)));

    // The node's roster, as it knows it from the chain once the three are in: Dan joins after it last looked.
    type Shown = { id: string; call: { sfu: string } | null; members: { key: string; me: boolean }[] };
    const shown = async () => (await node.run("group", "show", group)) as unknown as Shown;
    await expect.poll(async () => (await shown()).members.length, { timeout: 180_000, intervals: [2_000] }).toBe(4);
    const before = await shown();
    expect(before.call?.sfu).toBe(endpoints.sfu.origin);
    const keys = before.members.filter((m) => !m.me).map((m) => m.key);
    const roster = await fetch(`${endpoints.sfu.token}/test/roster/${before.id}`, { method: "PUT", body: JSON.stringify(Object.fromEntries(keys.map((k) => [k, "Member"]))) });
    expect(roster.status).toBe(204);
    await joinGroup(dan, link);

    // Join call is in the header once the group's call field reaches the member; it opens the call window.
    for (const p of callers) {
      await expect(p.page.getByTestId("group-call-join")).toBeVisible({ timeout: 120_000 });
      await p.page.getByTestId("group-call-join").click();
    }
    for (const p of callers) {
      await expect(p.page.getByTestId("group-call")).toBeVisible({ timeout: 30_000 });
      await expect(p.page.locator('[data-testid="group-call-tile"][data-kind="face"]')).toHaveCount(3, { timeout: 60_000 });
    }
    // Each member's key: the identity of its own tile, the one named You.
    const [a, b, c] = await Promise.all(callers.map(async (p) => (await p.page.locator('[data-testid="group-call-tile"][data-kind="face"]').filter({ has: p.page.getByText("You", { exact: true }) }).getAttribute("data-identity"))!));
    expect(new Set([a, b, c])).toEqual(new Set(keys));
    // Everyone hears everyone: each remote microphone plays in its own <audio>, and nobody shows the muted mark.
    for (const p of callers) {
      await expect.poll(() => p.page.getByTestId("group-call-audio").evaluateAll((els) => (els as HTMLAudioElement[]).filter((el) => el.srcObject && !el.paused).length), { timeout: 30_000 }).toBe(2);
      await expect(p.page.getByTestId("group-call-muted")).toHaveCount(0);
    }

    // Ana mutes: the mark shows on her tile for Bia and Cleo.
    await ana.page.getByTestId("group-call-mic").click();
    for (const p of [bia, cleo]) await expect(tile(p, a, "face").getByTestId("group-call-muted")).toBeVisible({ timeout: 15_000 });

    // Bia shares her screen: Ana and Cleo get the screen track, large.
    await bia.page.getByTestId("group-call-screen").click();
    for (const p of [ana, cleo]) await plays(p, b, "screen");

    // Cleo leaves: her tile goes from the others' windows.
    await cleo.page.getByTestId("group-call-leave").click();
    for (const p of [ana, bia]) await expect(tile(p, c, "face")).toHaveCount(0, { timeout: 30_000 });

    // Dan is a member, but not in the node's roster: no pass, and one line that says so.
    await expect(dan.page.getByTestId("group-call-join")).toBeVisible({ timeout: 120_000 });
    await dan.page.getByTestId("group-call-join").click();
    await expect(dan.page.getByTestId("group-call-problem-notice")).toContainText(REFUSED, { timeout: 60_000 });
    await expect(dan.page.getByTestId("group-call-tile")).toHaveCount(0);
    await expect(ana.page.locator('[data-testid="group-call-tile"][data-kind="face"]')).toHaveCount(2);

    testInfo.annotations.push({ type: "run time", description: `${Math.round((Date.now() - started) / 1000)} s` });
  } catch (error) {
    await node.attachLogs(testInfo);
    throw error;
  } finally {
    await node.stop();
  }
});

/*
 * A community group whose call is sealed end to end (WISP 602 § End-to-end encryption): the node's admin turns it on
 * with `group call --sfu ... --e2ee`. Two members join; each sees the other's screen and hears the other, so each opens
 * media sealed with the group's call key. An outsider whose key the node's roster lets in gets a valid pass and joins
 * the same room from the mock's page, sealed with a key of its own: the screen's packets reach it, and not one frame
 * of them decodes.
 */
const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";
/** A key as WISP 602 spells it (z-base32 of the 32 public key bytes, 52 characters), and its private half. */
function outsiderKey(): { k: string; key: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  let bits = BigInt(`0x${publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}`) << 4n;
  let k = "";
  for (let i = 0; i < 52; i++, bits >>= 5n) k = ZBASE32[Number(bits & 31n)] + k;
  return { k, key: privateKey };
}

/** A pass into `g`'s room from the mock for `k`, by a request `k` signs (WISP 602 § The token request). */
async function outsiderPass(g: string, { k, key }: ReturnType<typeof outsiderKey>): Promise<{ url: string; token: string }> {
  const body = { v: 1, g, k, room: `g_${g}`, ts: Math.floor(Date.now() / 1000), n: randomBytes(16).toString("base64url") };
  const signed = Buffer.from(JSON.stringify(["ghostly-sfu/1 token", endpoints.sfu.origin, g, body.room, k, body.ts, body.n]));
  const res = await fetch(`${endpoints.sfu.token}/sfu/group-token`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, name: "Outsider", sig: sign(null, signed, key).toString("base64url") }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { url: string; token: string };
}

/** What the outsider's page got of `identity`'s video: bytes received and frames decoded, over every inbound stream. */
const received = (page: Page, identity: string) => page.evaluate(async (id) => {
  type Pub = { kind: string; track?: { getRTCStatsReport(): Promise<RTCStatsReport | undefined> } };
  const room = (window as unknown as { room: { remoteParticipants: Map<string, { trackPublications: Map<string, Pub> }> } }).room;
  let bytes = 0, frames = 0;
  for (const pub of room.remoteParticipants.get(id)?.trackPublications.values() ?? []) {
    if (pub.kind !== "video" || !pub.track) continue;
    (await pub.track.getRTCStatsReport())?.forEach((s: { type: string; bytesReceived?: number; framesDecoded?: number }) => {
      if (s.type === "inbound-rtp") { bytes += s.bytesReceived ?? 0; frames += s.framesDecoded ?? 0; }
    });
  }
  return { bytes, frames };
}, identity);

test.describe("a sealed group call", () => {
  test("two members decode each other's sealed media; an outsider with a valid pass but not the group's call key decodes none", { tag: ["@feature:calls.group.e2ee", "@feature:calls.group.screen"] }, async ({ peer, relay, browser }, testInfo) => {
    const node = new HeadlessBot();
    try {
      await node.start(await relay.listen(), "Thursday node");
      const group = (await node.run("group", "create", "Thursday")).group as string;
      await node.run("group", "call", group, "--sfu", endpoints.sfu.origin, "--e2ee");
      const link = (await node.run("group", "link", group)).link as string;

      const [ana, bia] = await Promise.all(["Ana", "Bia"].map((name) => peer(name)));
      for (const p of [ana, bia]) await routeSfu(p);
      await Promise.all([ana, bia].map((p) => joinGroup(p, link)));

      type Shown = { id: string; call: { sfu: string; e2ee?: 1 } | null; members: { key: string; me: boolean }[] };
      const shown = async () => (await node.run("group", "show", group)) as unknown as Shown;
      await expect.poll(async () => (await shown()).members.length, { timeout: 180_000, intervals: [2_000] }).toBe(3);
      const before = await shown();
      expect(before.call).toEqual({ sfu: endpoints.sfu.origin, e2ee: 1 });
      const keys = before.members.filter((m) => !m.me).map((m) => m.key);
      const outsider = outsiderKey();
      // The node lets the outsider in too: its pass is as valid as the members'. Only the call key is missing.
      const roster = await fetch(`${endpoints.sfu.token}/test/roster/${before.id}`, {
        method: "PUT", body: JSON.stringify({ ...Object.fromEntries(keys.map((k) => [k, "Member"])), [outsider.k]: "Outsider" }),
      });
      expect(roster.status).toBe(204);

      for (const p of [ana, bia]) {
        await expect(p.page.getByTestId("group-call-join")).toBeVisible({ timeout: 120_000 });
        await expect(p.page.getByTestId("group-call-join")).not.toHaveAttribute("aria-disabled", "true");
        await p.page.getByTestId("group-call-join").click();
      }
      for (const p of [ana, bia]) {
        await expect(p.page.getByTestId("group-call")).toBeVisible({ timeout: 30_000 });
        await expect(p.page.locator('[data-testid="group-call-tile"][data-kind="face"]')).toHaveCount(2, { timeout: 60_000 });
      }
      const [a, b] = await Promise.all([ana, bia].map(async (p) => (await p.page.locator('[data-testid="group-call-tile"][data-kind="face"]').filter({ has: p.page.getByText("You", { exact: true }) }).getAttribute("data-identity"))!));
      expect(new Set([a, b])).toEqual(new Set(keys));

      // Sealed both ways: Ana hears Bia and Bia hears Ana, and Bia's shared screen plays for Ana.
      for (const p of [ana, bia]) {
        await expect.poll(() => p.page.getByTestId("group-call-audio").evaluateAll((els) => (els as HTMLAudioElement[]).filter((el) => el.srcObject && !el.paused).length), { timeout: 30_000 }).toBe(1);
      }
      await bia.page.getByTestId("group-call-screen").click();
      await plays(ana, b, "screen");
      await expect(ana.page.getByTestId("group-call-problem")).toHaveCount(0);

      // The outsider: a pass the node signed, the room's media flowing to it, and a key of its own.
      const pass = await outsiderPass(before.id, outsider);
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${endpoints.sfu.token}/smoke`);
      await page.evaluate(([u, t, p]) => (window as unknown as { joinSealed(u: string, t: string, p: string): Promise<void> }).joinSealed(u, t, p), [pass.url, pass.token, randomBytes(32).toString("base64url")]);
      await expect.poll(async () => (await received(page, b)).bytes, { timeout: 30_000 }).toBeGreaterThan(50_000);
      const after = await received(page, b);
      expect(after.frames).toBe(0);
      for (const width of await page.locator("video").evaluateAll((els) => (els as HTMLVideoElement[]).map((v) => v.videoWidth))) expect(width).toBe(0);
      // Still the members' call: they go on decoding each other while the outsider is in the room.
      await plays(ana, b, "screen");
      await page.context().close();
    } catch (error) {
      await node.attachLogs(testInfo);
      throw error;
    } finally {
      await node.stop();
    }
  });
});

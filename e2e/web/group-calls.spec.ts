import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import { endpoints } from "../infra/env.mjs";
import { expect, test, type Peer } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";
import { installSealProbe, pictures, sealProbe, shareTestPattern, type Picture } from "../support/sealProbe";

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

/** How many of the others this member hears: remote microphones playing, each in its own <audio>. */
const hearing = (peer: Peer): Promise<number> =>
  peer.page.getByTestId("group-call-audio").evaluateAll((els) => (els as HTMLAudioElement[]).filter((el) => el.srcObject && !el.paused).length);

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
      await expect.poll(() => hearing(p), { timeout: 30_000 }).toBe(2);
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
 * with `group call --sfu ... --e2ee`. Two members join; Bia shares a known test pattern as her screen, and Ana hears
 * her and sees it. Two outsiders whose keys the node's roster lets in get valid passes and join the same room from the
 * mock's page: one sealed with a key of its own, one with no E2EE at all. The screen's packets reach both, and neither
 * ever shows the pattern.
 *
 * Three proofs, each measured below LiveKit's events (support/sealProbe.ts):
 * - the sender: every sender of each member's page carrying a track has its encoded frames taken into a transform,
 *   and the frames out of LiveKit's encode transform are sealed (longer by tag, IV and trailer, other bytes), as many
 *   as the encoder made, none in the clear;
 * - the outsiders: `getStats()` on their own connections shows the video's bytes growing while no frame of the
 *   sender's size decodes (the wrong key's worker drops every frame), and their received tracks drawn to a canvas never
 *   show the pattern (with no E2EE the decoder may make noise of the ciphertext, never the picture);
 * - the member: Ana's worker opens Bia's frames, and Bia's screen tile drawn to a canvas shows the pattern.
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

/**
 * The web app the page runs is this checkout's build: its `ghostly-build` tag (apps/web/vite.config.ts) names this
 * checkout's commit. Locally Playwright serves whatever already listens on the suite's port (`reuseExistingServer`), so
 * another checkout's `vite preview` there (another session's, or a nightly round's, on the same port) would be tested
 * in its place, without this code. Skipped against a deployed app (`E2E_WEB_URL`).
 */
async function servesThisCheckout(page: Page): Promise<void> {
  if (process.env.E2E_WEB_URL) return;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const build = ((await page.locator('meta[name="ghostly-build"]').getAttribute("content")) ?? "").split(" ").at(-1) ?? "";
  expect(build.length >= 7 && head.startsWith(build), `the app served on ${page.url()} is build "${build}", not this checkout's ${head.slice(0, 12)}: another checkout's server is on the port; stop it or pick a free E2E_WEB_PORT`).toBe(true);
}

/** The mock's page, probed, in a context of its own. */
async function outsiderPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  await installSealProbe(context);
  const page = await context.newPage();
  await page.goto(`${endpoints.sfu.token}/smoke`);
  return page;
}

/** The most quadrants of the pattern any of the page's videos showed, over `times` looks a second or more apart. */
async function mostMatched(page: Page, times: number, selector?: string): Promise<{ matched: number; shots: Picture[] }> {
  let best = { matched: -1, shots: [] as Picture[] };
  for (let i = 0; i < times; i++) {
    const shots = await pictures(page, selector);
    const matched = Math.max(0, ...shots.map((s) => s.matched));
    if (matched > best.matched) best = { matched, shots };
    await page.waitForTimeout(1_000);
  }
  return best;
}

test.describe("a sealed group call", () => {
  test("two members decode each other's sealed media; outsiders with a valid pass but not the group's call key decode none", { tag: ["@feature:calls.group.e2ee", "@feature:calls.group.screen"] }, async ({ peer, relay, browser }, testInfo) => {
    const node = new HeadlessBot();
    // Every number the proofs read, printed at the end or at the failure: what to paste back from a run.
    const numbers: Record<string, unknown> = {};
    const outsiders: Page[] = [];
    const probed: [string, Page][] = [];
    try {
      await node.start(await relay.listen(), "Thursday node");
      const group = (await node.run("group", "create", "Thursday")).group as string;
      await node.run("group", "call", group, "--sfu", endpoints.sfu.origin, "--e2ee");
      const link = (await node.run("group", "link", group)).link as string;

      const ana = await peer("Ana", { beforeOpen: installSealProbe });
      const bia = await peer("Bia", { beforeOpen: async (context) => { await installSealProbe(context); await shareTestPattern(context); } });
      for (const p of [ana, bia]) await routeSfu(p);
      probed.push(["ana", ana.page], ["bia", bia.page]);
      await servesThisCheckout(ana.page);
      await Promise.all([ana, bia].map((p) => joinGroup(p, link)));

      // `group show` prints the signed `e2ee: 1` as a flag, as it prints `picture` (the CLI's JSON style).
      type Shown = { id: string; call: { sfu: string; e2ee: boolean } | null; members: { key: string; me: boolean }[] };
      const shown = async () => (await node.run("group", "show", group)) as unknown as Shown;
      await expect.poll(async () => (await shown()).members.length, { timeout: 180_000, intervals: [2_000] }).toBe(3);
      const before = await shown();
      expect(before.call).toEqual({ sfu: endpoints.sfu.origin, e2ee: true });
      const keys = before.members.filter((m) => !m.me).map((m) => m.key);
      const wrongKey = outsiderKey(), noE2ee = outsiderKey();
      // The node lets the outsiders in too: their passes are as valid as the members'. Only the call key is missing.
      const roster = await fetch(`${endpoints.sfu.token}/test/roster/${before.id}`, {
        method: "PUT", body: JSON.stringify({ ...Object.fromEntries(keys.map((k) => [k, "Member"])), [wrongKey.k]: "Outsider", [noE2ee.k]: "Outsider" }),
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

      // Sealed both ways: Ana hears Bia and Bia hears Ana, and Bia's shared screen (the pattern) plays for Ana.
      for (const p of [ana, bia]) {
        await expect.poll(() => hearing(p), { timeout: 30_000 }).toBe(1);
      }
      await bia.page.getByTestId("group-call-screen").click();
      await plays(ana, b, "screen");
      await expect(ana.page.getByTestId("group-call-problem")).toHaveCount(0);

      // (c) The member: Bia's screen tile, drawn to a canvas, shows the pattern, and Ana's worker opened those frames.
      const screenTile = `[data-testid="group-call-tile"][data-identity="${b}"][data-kind="screen"] video`;
      await expect.poll(async () => Math.max(0, ...(await pictures(ana.page, screenTile)).map((s) => s.matched)), { timeout: 30_000, intervals: [1_000] }).toBe(4);
      numbers.memberPicture = (await pictures(ana.page, screenTile))[0];
      // The same check on what Ana's connection receives, each track in the probe's own element: the way the outsiders
      // are looked at below, so their "no picture" is not a blind spot of the check.
      await expect.poll(async () => Math.max(0, ...(await pictures(ana.page)).map((s) => s.matched)), { timeout: 30_000, intervals: [1_000] }).toBe(4);

      // (b) The outsiders. One joins sealed under a key of its own, the app's livekit-client and worker on the mock's
      // page; one joins with no E2EE at all, so its decoder gets what the wire carries.
      const sealedPage = await outsiderPage(browser);
      outsiders.push(sealedPage);
      probed.push(["wrongKey", sealedPage]);
      const sealedPass = await outsiderPass(before.id, wrongKey);
      await sealedPage.evaluate(([u, t, k]) => (window as unknown as { joinSealed(u: string, t: string, k: string): Promise<void> }).joinSealed(u, t, k), [sealedPass.url, sealedPass.token, randomBytes(32).toString("base64url")]);
      const plainPage = await outsiderPage(browser);
      outsiders.push(plainPage);
      probed.push(["noE2ee", plainPage]);
      const plainPass = await outsiderPass(before.id, noE2ee);
      await plainPage.evaluate(async ([u, t]) => {
        const lk = (window as unknown as { LivekitClient: { Room: new (options: object) => { connect(u: string, t: string): Promise<void> } } }).LivekitClient;
        const room = new lk.Room({ adaptiveStream: false });
        (window as unknown as { room: unknown }).room = room;
        await room.connect(u, t);
      }, [plainPass.url, plainPass.token]);

      for (const [name, page] of [["wrongKey", sealedPage], ["noE2ee", plainPage]] as const) {
        await expect.poll(async () => (await sealProbe(page)).inbound.video.bytesReceived, { timeout: 60_000, intervals: [1_000] }).toBeGreaterThan(50_000);
        const first = await sealProbe(page);
        // The screen keeps coming, 20 kB more of it at least.
        await expect.poll(async () => (await sealProbe(page)).inbound.video.bytesReceived, { timeout: 60_000, intervals: [1_000] }).toBeGreaterThan(first.inbound.video.bytesReceived + 20_000);
        const seen = await mostMatched(page, 5);
        const probe = await sealProbe(page);
        numbers[name] = { first: first.inbound.video, after: probe.inbound.video, decode: probe.decode.video, streams: probe.streams, picture: seen };
        // Never the picture: a frame of Bia's screen in the clear would show all four colours.
        expect(seen.matched, `${name} showed ${seen.matched} of the pattern's 4 quadrants`).toBeLessThan(2);
      }
      const wrong = await sealProbe(sealedPage);
      // The wrong key: its worker handed its decoder nothing but the SFU's own 8x8 blank frames, and no frame of Bia's
      // screen ever decoded. (Its worker's frames in, and how many carried LiveKit's trailer, are in the numbers: what
      // the wire carries is proven by the outsider with no E2EE above, whose decoder gets it as it comes.)
      expect(wrong.hooked).toBe(true);
      expect(wrong.decode.video.out).toBe(wrong.decode.video.sif);
      expect(wrong.inbound.video.framesDecoded).toBeLessThanOrEqual(wrong.decode.video.sif);
      expect(wrong.inbound.video.frameWidth).toBeLessThanOrEqual(8);
      numbers.wrongKeySealErrors = await sealedPage.evaluate(() => (window as unknown as { sealErrors?: number }).sealErrors ?? null);

      // (c) again, from Ana's worker: Bia's frames came sealed and were opened, none passed in the clear.
      const member = await sealProbe(ana.page);
      numbers.member = { decode: member.decode, inbound: member.inbound.video, streams: member.streams };
      expect(member.hooked).toBe(true);
      // The stats the outsiders are read by count Ana's decoded frames.
      expect(member.inbound.video.framesDecoded).toBeGreaterThan(30);
      expect(member.decode.video.opened).toBeGreaterThan(30);
      expect(member.decode.video.clear).toBe(0);
      expect(member.decode.audio.clear).toBe(0);

      // (a) The senders. Every sender with a track went through a transform, and what left was sealed: Bia's screen
      // frames as many as her encoder made, and both microphones, none in the clear.
      for (const [name, p] of [["bia", bia], ["ana", ana]] as const) {
        const probe = await sealProbe(p.page);
        numbers[`${name}Sender`] = { senders: probe.senders, encode: probe.encode, outbound: probe.outbound, streams: probe.streams };
        expect(probe.hooked).toBe(true);
        expect(probe.senders.length).toBeGreaterThanOrEqual(name === "bia" ? 2 : 1);
        expect(probe.senders.filter((s) => !s.transformed), `${name}'s senders without a transform`).toEqual([]);
        expect(probe.encode.audio.sealed).toBeGreaterThan(50);
        expect(probe.encode.audio.clear).toBe(0);
        expect(probe.encode.video.clear).toBe(0);
      }
      const sender = await sealProbe(bia.page);
      const encoded = sender.outbound.video.framesEncoded;
      expect(sender.encode.video.sealed).toBeGreaterThan(60);
      // Every frame the encoder made went into the transform, and (but those in flight) came out sealed.
      expect(Math.abs(sender.encode.video.in - encoded), `transform in ${sender.encode.video.in}, encoded ${encoded}`).toBeLessThanOrEqual(Math.max(15, encoded * 0.1));
      expect(sender.encode.video.sealed).toBeGreaterThanOrEqual(sender.encode.video.in * 0.9);

      // Still the members' call: they go on decoding each other while the outsiders are in the room.
      await plays(ana, b, "screen");
      testInfo.annotations.push({ type: "seal probe", description: JSON.stringify(numbers) });
      console.log(`  seal probe: ${JSON.stringify(numbers)}`);
    } catch (error) {
      // Every page's probe as it stands, whatever step failed.
      for (const [name, page] of probed) numbers[`${name}AtFailure`] = await sealProbe(page).catch((e: Error) => e.message);
      console.log(`  seal probe (at the failure): ${JSON.stringify(numbers)}`);
      testInfo.annotations.push({ type: "seal probe", description: JSON.stringify(numbers) });
      await node.attachLogs(testInfo);
      throw error;
    } finally {
      for (const page of outsiders) await page.context().close().catch(() => {});
      await node.stop();
    }
  });
});

/*
 * The group's admin moderates its call (WISP 602 § Moderation). The headless node makes Ana the group's admin, so her
 * app signs the moderation requests and shows the ⋮ on the others' tiles; the stack's token mock is the group's node
 * here too, keeping the room's mutes and bans and acting on LiveKit for them (e2e/infra/sfu-token).
 */
const MUTED_BY_ADMIN = "Muted by the admin";
const REMOVED = "The admin removed you from this call";

test.describe("group call moderation", () => {
  test("the admin mutes a member's mic and allows it again, removes a member and lets them back in; nobody else gets the menu", { tag: ["@feature:calls.group.moderation"] }, async ({ peer, relay }, testInfo) => {
    const started = Date.now();
    const node = new HeadlessBot();
    try {
      await node.start(await relay.listen(), "Thursday node");
      const group = (await node.run("group", "create", "Thursday")).group as string;
      await node.run("group", "call", group, "--sfu", endpoints.sfu.origin);
      const link = (await node.run("group", "link", group)).link as string;

      const [ana, bia, cleo] = await Promise.all(["Ana", "Bia", "Cleo"].map((name) => peer(name)));
      for (const p of [ana, bia, cleo]) await routeSfu(p);
      await servesThisCheckout(ana.page);
      const callers = [ana, bia, cleo];

      // Ana joins first and the node hands her the admin role.
      type Shown = { id: string; admin: boolean; call: { sfu: string } | null; members: { key: string; me: boolean }[] };
      const shown = async () => (await node.run("group", "show", group)) as unknown as Shown;
      await joinGroup(ana, link);
      await expect.poll(async () => (await shown()).members.length, { timeout: 180_000, intervals: [2_000] }).toBe(2);
      const a = (await shown()).members.find((m) => !m.me)!.key;
      // She has the node's statement naming the call node before the role moves: made the admin before her first sync,
      // she takes the role commit first and then refuses the former admin's statement, and the group's call is lost.
      await expect(ana.page.getByTestId("group-call-join")).toBeVisible({ timeout: 120_000 });
      await node.run("group", "admin", group, a);
      await expect(ana.page.getByTestId("group-event").filter({ hasText: "You are now the admin" })).toHaveCount(1, { timeout: 60_000 });

      await Promise.all([bia, cleo].map((p) => joinGroup(p, link)));
      await expect.poll(async () => (await shown()).members.length, { timeout: 180_000, intervals: [2_000] }).toBe(4);
      const before = await shown();
      expect(before.admin).toBe(false);
      expect(before.call?.sfu).toBe(endpoints.sfu.origin);
      const keys = before.members.filter((m) => !m.me).map((m) => m.key);
      // The node's roster names Ana its admin: the only key whose moderation requests it takes.
      const roster = await fetch(`${endpoints.sfu.token}/test/roster/${before.id}`, { method: "PUT", body: JSON.stringify({ members: Object.fromEntries(keys.map((k) => [k, "Member"])), admin: a }) });
      expect(roster.status).toBe(204);

      for (const p of callers) {
        await expect(p.page.getByTestId("group-call-join")).toBeVisible({ timeout: 120_000 });
        await p.page.getByTestId("group-call-join").click();
      }
      const faces = '[data-testid="group-call-tile"][data-kind="face"]';
      for (const p of callers) {
        await expect(p.page.getByTestId("group-call")).toBeVisible({ timeout: 30_000 });
        await expect(p.page.locator(faces)).toHaveCount(3, { timeout: 60_000 });
      }
      const [me, b, c] = await Promise.all(callers.map(async (p) => (await p.page.locator(faces).filter({ has: p.page.getByText("You", { exact: true }) }).getAttribute("data-identity"))!));
      expect(me).toBe(a);
      expect(new Set([a, b, c])).toEqual(new Set(keys));
      for (const p of callers) await expect.poll(() => hearing(p), { timeout: 30_000 }).toBe(2);

      // The admin has the ⋮ on the others' tiles, not on her own; Bia and Cleo have it on none.
      for (const k of [b, c]) await expect(tile(ana, k, "face").getByTestId("group-call-moderate")).toHaveAttribute("aria-label", /^Moderate .+/);
      await expect(tile(ana, a, "face").getByTestId("group-call-moderate")).toHaveCount(0);
      for (const p of [bia, cleo]) await expect(p.page.getByTestId("group-call-moderate")).toHaveCount(0);
      const menuOn = async (k: string) => {
        await tile(ana, k, "face").getByTestId("group-call-moderate").click();
        const menu = ana.page.getByTestId("group-call-moderate-menu");
        await expect(menu).toBeVisible();
        return menu;
      };

      // Ana mutes Bia's mic. Bia's mic button and her own tile say why, and its ⓘ says until when.
      let menu = await menuOn(b);
      await expect(menu.getByTestId("group-call-mute-microphone")).toHaveText("Mute mic");
      await menu.getByTestId("group-call-mute-microphone").click();
      const mic = bia.page.getByTestId("group-call-mic");
      await expect(mic).toHaveAttribute("aria-disabled", "true", { timeout: 15_000 });
      await expect(mic).toHaveAttribute("title", MUTED_BY_ADMIN);
      await expect(tile(bia, b, "face").getByRole("img", { name: MUTED_BY_ADMIN })).toBeVisible();
      await bia.page.getByTestId("group-call-by-admin-info").click();
      await expect(bia.page.getByTestId("group-call-by-admin-text")).toContainText("The group's admin turned this off for you in this call.");
      // Ana and Cleo see the admin's mark on her tile, and no longer hear her: one microphone each, the other's.
      for (const p of [ana, cleo]) {
        await expect(tile(p, b, "face").getByTestId("group-call-muted")).toHaveAttribute("data-by-admin", "true", { timeout: 15_000 });
        await expect.poll(() => hearing(p), { timeout: 30_000 }).toBe(1);
      }
      // Bia presses her mic (aria-disabled, which Playwright would wait out: a person can still press it): it stays
      // muted, and still nobody hears her once Ana's menu offers Allow mic.
      await mic.click({ force: true });
      await expect(mic).toHaveAttribute("aria-disabled", "true");
      await expect(mic).toHaveAttribute("title", MUTED_BY_ADMIN);
      menu = await menuOn(b);
      await expect(menu.getByTestId("group-call-allow-microphone")).toHaveText("Allow mic");
      for (const p of [ana, cleo]) expect(await hearing(p)).toBe(1);

      // Ana allows it: Bia's mic is hers again but stays off until she turns it on; then both hear her.
      await menu.getByTestId("group-call-allow-microphone").click();
      await expect(mic).not.toHaveAttribute("aria-disabled", "true", { timeout: 15_000 });
      await expect(mic).toHaveAttribute("title", "Unmute");
      for (const p of [ana, cleo]) await expect(tile(p, b, "face").getByTestId("group-call-muted")).toHaveAttribute("data-by-admin", "false", { timeout: 15_000 });
      await mic.click();
      await expect(mic).toHaveAttribute("title", "Mute");
      for (const p of [ana, cleo]) {
        await expect(tile(p, b, "face").getByTestId("group-call-muted")).toHaveCount(0, { timeout: 15_000 });
        await expect.poll(() => hearing(p), { timeout: 30_000 }).toBe(2);
      }

      // Ana removes Cleo from the call, asked first.
      menu = await menuOn(c);
      await expect(menu.getByTestId("group-call-remove-from-call")).toHaveText("Remove from call");
      await menu.getByTestId("group-call-remove-from-call").click();
      const ask = ana.page.getByTestId("group-call-remove-call-dialog");
      await expect(ask).toContainText("from the call?");
      await ask.getByTestId("group-call-remove-call-confirm").click();
      // Cleo is out of the room, Join call is off and says why; Ana and Bia lose her tile and her voice.
      const notice = cleo.page.getByTestId("group-call-problem-notice");
      await expect(cleo.page.getByTestId("group-call")).toHaveCount(0, { timeout: 30_000 });
      await expect(notice).toContainText(REMOVED, { timeout: 30_000 });
      await expect(cleo.page.getByTestId("group-call-join")).toHaveAttribute("aria-disabled", "true");
      for (const p of [ana, bia]) {
        await expect(tile(p, c, "face")).toHaveCount(0, { timeout: 30_000 });
        await expect.poll(() => hearing(p), { timeout: 30_000 }).toBe(1);
      }
      await expect(ana.page.getByTestId("group-call-removed")).toHaveText("Removed (1)");
      await expect(bia.page.getByTestId("group-call-removed")).toHaveCount(0);

      // Her rejoin is refused: the notice closed, Join call asks the node again, and the same reason comes back.
      await cleo.page.getByTestId("group-call-problem").getByRole("button", { name: "Close" }).click();
      await expect(cleo.page.getByTestId("group-call-problem")).toHaveCount(0);
      // Join call stays aria-disabled while she is removed, and pressed it still asks the node (GroupCallButton's press).
      await cleo.page.getByTestId("group-call-join").click({ force: true });
      await expect(notice).toContainText(REMOVED, { timeout: 60_000 });
      await expect(cleo.page.getByTestId("group-call")).toHaveCount(0);
      await expect(ana.page.locator(faces)).toHaveCount(2);

      // Ana lets her back in, and Cleo's Join call takes her into the room: three tiles, everyone heard again.
      await ana.page.getByTestId("group-call-removed").click();
      const unban = ana.page.getByTestId("group-call-removed-menu").locator(`[data-testid="group-call-unban"][data-identity="${c}"]`);
      await expect(unban).toHaveText(/^Let .+ back in$/);
      await unban.click();
      await expect(ana.page.getByTestId("group-call-removed")).toHaveCount(0, { timeout: 15_000 });
      await cleo.page.getByTestId("group-call-join").click({ force: true });
      await expect(cleo.page.getByTestId("group-call")).toBeVisible({ timeout: 60_000 });
      await expect(cleo.page.getByTestId("group-call-problem")).toHaveCount(0);
      for (const p of callers) {
        await expect(p.page.locator(faces)).toHaveCount(3, { timeout: 60_000 });
        await expect.poll(() => hearing(p), { timeout: 30_000 }).toBe(2);
      }
      await expect(cleo.page.getByTestId("group-call-moderate")).toHaveCount(0);

      testInfo.annotations.push({ type: "run time", description: `${Math.round((Date.now() - started) / 1000)} s` });
    } catch (error) {
      await node.attachLogs(testInfo);
      throw error;
    } finally {
      await node.stop();
    }
  });
});

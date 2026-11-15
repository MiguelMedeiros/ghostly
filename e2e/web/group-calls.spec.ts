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

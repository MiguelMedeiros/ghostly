import { endpoints } from "../infra/env.mjs";
import { expect, openProfilePage, test, type Peer } from "../support/fixtures";
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

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

async function joinGroup(peer: Peer, link: string): Promise<void> {
  await peer.page.goto(link.includes("#") ? "/" + link.slice(link.indexOf("#")) : `/#/join/${link}`);
  await expect(peer.page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 180_000 });
}

test("three members join a community group's call, see and hear each other, see a shared screen; an outsider gets no pass", { tag: ["@feature:groups.call.join", "@feature:groups.call.screen", "@feature:groups.call.refused"] }, async ({ peer, relay }, testInfo) => {
  const started = Date.now();
  const node = new HeadlessBot();
  try {
    await node.start(await relay.listen(), "Thursday node");
    const group = (await node.run("group", "create", "Thursday")).group as string;
    await node.run("group", "call", group, "--sfu", endpoints.sfu.origin);
    const link = (await node.run("group", "link", group)).link as string;

    const [ana, bia, cleo, dan] = await Promise.all(["Ana", "Bia", "Cleo", "Dan"].map((name) => peer(name)));
    for (const p of [ana, bia, cleo, dan]) await routeSfu(p);
    await Promise.all([ana, bia, cleo, dan].map((p) => setName(p, p.name)));
    await Promise.all([ana, bia, cleo, dan].map((p) => joinGroup(p, link)));

    // Each member's key, by the name the node has for it.
    type Shown = { id: string; call?: { sfu?: string }; members: { key: string; name: string | null }[] };
    let shown = (await node.run("group", "show", group)) as unknown as Shown;
    await expect.poll(async () => {
      shown = (await node.run("group", "show", group)) as unknown as Shown;
      return shown.members.map((m) => m.name).filter((name) => name && name !== "Thursday node").sort();
    }, { timeout: 180_000, intervals: [2_000] }).toEqual(["Ana", "Bia", "Cleo", "Dan"]);
    expect(shown.call?.sfu).toBe(endpoints.sfu.origin);
    const [a, b, c, d] = ["Ana", "Bia", "Cleo", "Dan"].map((name) => shown.members.find((m) => m.name === name)!.key);
    // The node's roster, as it knows it from the chain: everyone but Dan, who joined after the node last looked.
    const roster = await fetch(`${endpoints.sfu.token}/test/roster/${shown.id}`, { method: "PUT", body: JSON.stringify({ [a]: "Ana", [b]: "Bia", [c]: "Cleo" }) });
    expect(roster.status).toBe(204);

    // Join call is in the header of a group that names an SFU; it opens the call window.
    for (const p of [ana, bia, cleo]) await p.page.getByTestId("group-call-join").click();
    const callers = [[ana, a], [bia, b], [cleo, c]] as const;
    for (const [p] of callers) {
      await expect(p.page.getByTestId("group-call")).toBeVisible({ timeout: 30_000 });
      await expect(p.page.locator('[data-testid="group-call-tile"][data-kind="face"]')).toHaveCount(3, { timeout: 60_000 });
    }
    // Everyone hears everyone: each remote microphone plays in its own <audio>, and nobody shows the muted mark.
    for (const [p] of callers) {
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
    await dan.page.getByTestId("group-call-join").click();
    await expect(dan.page.getByText(REFUSED)).toBeVisible({ timeout: 60_000 });
    await expect(dan.page.getByTestId("group-call-tile")).toHaveCount(0);
    await expect(tile(ana, d, "face")).toHaveCount(0);

    testInfo.annotations.push({ type: "run time", description: `${Math.round((Date.now() - started) / 1000)} s` });
  } catch (error) {
    await node.attachLogs(testInfo);
    throw error;
  } finally {
    await node.stop();
  }
});

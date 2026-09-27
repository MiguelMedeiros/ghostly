import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

/**
 * A contact's app restarting takes the chat off live only for a moment (WISP 100, "Back after a restart"). Each side
 * goes in turn, so both key orders are covered (the lower key dials).
 * - A page reloading says goodbye and closes its connection on the way out: the other side is off live at once, and
 *   both are live again in about 3 s (as before revision 0.6, where the browser's own close already did it).
 * - A page that crashes says nothing: the other side's connection only goes `disconnected`. It reads the contact's
 *   packet then, sees the restarted page's new one and ends the dead session, instead of waiting out the connection's
 *   grace (about 17 s before revision 0.6).
 * A Desktop restart over Iroh (a minute or more before) is measured in packages/core/test/restartRelink.test.ts.
 */
const LIVE_AGAIN_MS = 10_000;
const CRASHED_LIVE_AGAIN_MS = 15_000;

const connectedOnWebRtc = (peer: Peer, timeout: number) =>
  expect(peer.page.getByTestId("connection-options")).toHaveAttribute("aria-label", /Connected · WebRTC/, { timeout });

test("a reloaded page is live again with its contact within seconds, whichever side reloads", { tag: ["@feature:chat.paired.reconnect", "@feature:core.liveness"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  for (const [goes, stays] of [[alice, bob], [bob, alice]] as const) {
    for (const p of [goes, stays]) await connectedOnWebRtc(p, 60_000);
    const started = Date.now();
    await goes.page.reload();
    // The page that stayed hears the goodbye: off live at once, not when its liveness gives up a minute later.
    await expect(stays.page.getByTestId("connection-options")).not.toHaveAttribute("aria-label", /Connected/, { timeout: 5_000 });
    await Promise.all([connectedOnWebRtc(goes, LIVE_AGAIN_MS), connectedOnWebRtc(stays, LIVE_AGAIN_MS)]);
    const took = Date.now() - started;
    test.info().annotations.push({ type: "live again", description: `${goes.name} reloaded: ${took} ms` });
    console.log(`[restart-relink] ${goes.name} reloaded, live again on both sides in ${took} ms`);

    // Direct both ways again, nothing lost.
    await say(goes, `${goes.name} is back`);
    await expect(chat(stays).getByText(`${goes.name} is back`)).toBeVisible({ timeout: 15_000 });
    await say(stays, `welcome back ${goes.name}`);
    await expect(chat(goes).getByText(`welcome back ${goes.name}`)).toBeVisible({ timeout: 15_000 });
  }
});

test("a page that crashes is live again with its contact once it is loaded again, whichever side crashed", { tag: ["@feature:chat.paired.reconnect", "@feature:core.liveness"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  for (const [goes, stays] of [[alice, bob], [bob, alice]] as const) {
    for (const p of [goes, stays]) await connectedOnWebRtc(p, 60_000);
    const url = goes.page.url();
    const started = Date.now();
    // The tab's renderer dies: no goodbye, no close; the WebRTC connection just stops answering.
    const dead = goes.page, crashed = new Promise(resolve => dead.once("crash", resolve));
    await dead.goto("chrome://crash").catch(() => {});
    await crashed;
    // Opened again in a new tab: a crashed one cannot be navigated.
    goes.page = await goes.context.newPage();
    await goes.page.goto(url);
    await dead.close();
    await Promise.all([connectedOnWebRtc(goes, CRASHED_LIVE_AGAIN_MS), connectedOnWebRtc(stays, CRASHED_LIVE_AGAIN_MS)]);
    const took = Date.now() - started;
    test.info().annotations.push({ type: "live again", description: `${goes.name} crashed: ${took} ms` });
    console.log(`[restart-relink] ${goes.name} crashed, live again on both sides in ${took} ms`);

    await say(goes, `${goes.name} survived`);
    await expect(chat(stays).getByText(`${goes.name} survived`)).toBeVisible({ timeout: 15_000 });
    await say(stays, `glad ${goes.name}`);
    await expect(chat(goes).getByText(`glad ${goes.name}`)).toBeVisible({ timeout: 15_000 });
  }
});

import { expect, test } from "../support/fixtures";

/**
 * With a member's app open, a join through a community's link takes seconds, however long that app
 * has been open. It used to take 15–22 s to get in and 26–62 s to reach a member once the app had been
 * open a minute or more (e2e/web/group-join-timing.spec.ts, `E2E_JOIN_WARM_MS=150000`): the hub's own
 * polling of knocks, lobby and beacon spent its whole relay budget, and the entry session's signaling
 * waited for what was left. Now 3–7 s and 7–12 s. The member's app is open a minute and a quarter
 * first, past that point; two people join, one right after the other. The second one's admission
 * shares the door's relay budget with the first one's (about 10 requests on each relay of the 30 a
 * minute), hence a little more room; the bounds leave room for a busy machine too.
 */
const JOIN_BOUND_MS = [12_000, 15_000];
const REACH_BOUND_MS = [20_000, 30_000];
const groupChat = (page: import("@playwright/test").Page) => page.getByTestId("group-chat");

/** Every step the joining card shows, in order, however quickly they go by. */
function watchSteps(): void {
  const w = window as unknown as { __stages?: string[] };
  if (w.__stages) return;
  w.__stages = [];
  new MutationObserver(() => {
    const stage = document.querySelector("[data-testid=group-joining-steps]")?.getAttribute("data-stage");
    if (stage && w.__stages!.at(-1) !== stage) w.__stages!.push(stage);
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-stage"] });
}

test("with a member's app open a while, joining a community through its link takes seconds and shows each step", { tag: ["@feature:groups.community.join"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const [alice, bob, carol] = await Promise.all([peer("alice"), peer("bob"), peer("carol")]);
  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await expect(alice.page.getByTestId("new-group-kind-community").getByRole("radio")).toBeChecked();
  await alice.page.getByTestId("new-group-name").fill("Open plaza");
  await alice.page.getByTestId("new-group-create").click();
  const shareDialog = alice.page.getByTestId("group-share-dialog");
  const url = await shareDialog.getByTestId("group-link-url").inputValue();
  await shareDialog.getByTestId("group-share-done").click();
  // Open past the first minute: its relay budget in the steady state of a hub's polling.
  await alice.page.waitForTimeout(75_000);

  for (const [joiner, members, n] of [[bob, 2, 0], [carol, 3, 1]] as const) {
    await joiner.page.addInitScript(watchSteps);
    await joiner.page.evaluate(watchSteps);
    const started = Date.now();
    await joiner.page.goto(url);
    await expect(groupChat(joiner.page)).toHaveAttribute("data-status", "active", { timeout: JOIN_BOUND_MS[n] });
    const joined = Date.now() - started;
    // A hub at least (the member who let it in): the others come through it.
    await expect(joiner.page.getByTestId("group-members")).toContainText(`${members} members · connected`, { timeout: REACH_BOUND_MS[n] });
    const reached = Date.now() - started;
    console.log(`  ${joiner.name} joined in ${joined} ms, reached a member in ${reached} ms`);
    expect(joined).toBeLessThan(JOIN_BOUND_MS[n]);
    expect(reached).toBeLessThan(REACH_BOUND_MS[n]);
    // The steps went forward only, and the card said something before the group opened.
    const stages = await joiner.page.evaluate(() => (window as unknown as { __stages: string[] }).__stages);
    const order = ["knocking", "knocked", "answered", "admitted"];
    expect(stages.length).toBeGreaterThan(0);
    expect(stages.map(s => order.indexOf(s))).toEqual(stages.map(s => order.indexOf(s)).sort((a, b) => a - b));
    await expect(alice.page.getByTestId("group-members")).toContainText(`${members} members`);
  }
});

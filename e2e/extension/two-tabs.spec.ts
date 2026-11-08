import { chat, say } from "../support/fixtures";
import { expect, test } from "../support/extension";
import { pair } from "../support/paired";

/**
 * The extension's pages share one peer (its offscreen document), and a person may have two of them open: a link
 * opened in a tab of its own, a duplicated tab. Both show the chat as it is. The second tab used to show only what
 * was there when it opened: the first tab mirrored each new message into the stored chat first, so the second
 * found nothing new to add and never read the chat again.
 */
test("two tabs of the extension on one chat both show what comes in and what either sends", { tag: ["@client:extension", "@client:web", "@feature:extension.engine"] }, async ({ extensionPeer, webPeer }) => {
  const [ext, web] = await Promise.all([extensionPeer("two-tabs"), webPeer("two-tabs-contact")]);
  await pair(web, ext);
  const second = { ...ext, page: await ext.context.newPage() };
  await second.page.goto(ext.page.url());
  await expect(chat(second)).toBeVisible({ timeout: 30_000 });

  await say(web, "to both tabs");
  for (const tab of [ext, second]) await expect(chat(tab).getByText("to both tabs")).toBeVisible({ timeout: 60_000 });

  await say(second, "from the second tab");
  await expect(chat(web).getByText("from the second tab")).toBeVisible({ timeout: 60_000 });
  for (const tab of [ext, second]) await expect(chat(tab).getByText("from the second tab")).toHaveCount(1);

  await say(ext, "from the first tab");
  await expect(chat(second).getByText("from the first tab")).toHaveCount(1, { timeout: 30_000 });
});

/**
 * Clear all data in one tab starts the peer again on an empty profile. The other tab reconnected to the new peer but
 * kept the cleared chat open, and what it sent there hung as pending, reaching nobody. It starts again now, as it does
 * after a profile switch made in another tab.
 */
test("Clear all data in one tab starts the other tab again, without the cleared chat", { tag: ["@client:extension", "@client:web", "@feature:extension.engine", "@feature:app.clear-data"] }, async ({ extensionPeer, webPeer }) => {
  const [ext, web] = await Promise.all([extensionPeer("two-tabs-clear"), webPeer("two-tabs-clear-contact")]);
  await pair(web, ext);
  await say(web, "before the clear");
  const second = { ...ext, page: await ext.context.newPage() };
  await second.page.goto(ext.page.url());
  await expect(chat(second).getByText("before the clear")).toBeVisible({ timeout: 30_000 });
  // Marks the page as it is now: a page that starts again comes without it.
  await second.page.evaluate(() => Object.assign(window, { __beforeClear: true }));

  await ext.page.goto(ext.page.url().replace(/#.*$/, "#/settings"));
  await ext.page.getByTestId("clear-all-data").click();
  await ext.page.getByTestId("clear-all-data-confirm").click();
  await expect(ext.page.getByTitle("New Chat")).toBeVisible({ timeout: 60_000 });

  // The reload destroys the page under an evaluate that is still running: that one only says it has not finished yet.
  await expect.poll(() => second.page.evaluate(() => "__beforeClear" in window).catch(() => true), { timeout: 30_000 }).toBe(false);
  await expect(second.page.getByTitle("New Chat")).toBeVisible({ timeout: 60_000 });
  await expect(second.page.getByText("It's quiet here...")).toBeVisible();
  await expect(second.page.getByPlaceholder("Message…")).toHaveCount(0);
});

/**
 * A call rings in every tab of the extension, which share one peer. One tab answered it, and the other rang on: a minute
 * later it wrote "Missed audio call" into the history of the call that was on, and its Decline ended that call. The
 * others stop ringing now once one tab answers or declines.
 */
test("a call answered or declined in one tab stops ringing in the other", { tag: ["@client:extension", "@client:web", "@feature:extension.engine", "@feature:calls.paired", "@feature:calls.decline"] }, async ({ extensionPeer, webPeer }) => {
  const [ext, web] = await Promise.all([extensionPeer("two-tabs-call"), webPeer("two-tabs-call-contact")]);
  await pair(web, ext);
  const second = { ...ext, page: await ext.context.newPage() };
  await second.page.goto(ext.page.url());
  await expect(chat(second)).toBeVisible({ timeout: 30_000 });
  const ringing = (tab: typeof ext) => tab.page.getByText("Incoming audio call...");

  await web.page.getByTestId("call-audio").click();
  for (const tab of [ext, second]) await expect(ringing(tab)).toBeVisible({ timeout: 30_000 });
  await ext.page.getByTitle("Accept audio call").click();
  for (const p of [ext, web]) await expect(p.page.getByText(/^\d{1,2}:\d{2}$/).first()).toBeVisible({ timeout: 30_000 });
  await expect(ringing(second)).toHaveCount(0, { timeout: 15_000 });
  await ext.page.getByTitle("End call").click();
  await expect(web.page.getByTitle("End call")).toHaveCount(0);
  for (const tab of [ext, second]) await expect(chat(tab).getByText("Audio call ended")).toBeVisible();

  // The other way: the second tab declines, and the first stops ringing.
  await web.page.getByTestId("call-audio").click();
  for (const tab of [ext, second]) await expect(ringing(tab)).toBeVisible({ timeout: 30_000 });
  await second.page.getByTitle("Decline").click();
  await expect(chat(web).getByText("Audio call declined")).toBeVisible({ timeout: 30_000 });
  await expect(ringing(ext)).toHaveCount(0, { timeout: 15_000 });
  for (const tab of [ext, second]) await expect(chat(tab).getByText(/Missed audio call/)).toHaveCount(0);
});

/**
 * Both tabs rang a call, each its own ring at once, out of step. One plays it now (it holds the `ghostly-ring:` lock),
 * the other waits, and takes over once the first stops ringing (closed, or its chat).
 */
test("a call ringing in two tabs rings in one of them", { tag: ["@client:extension", "@client:web", "@feature:extension.engine", "@feature:calls.ring-elsewhere", "@feature:app.attention.sounds"] }, async ({ extensionPeer, webPeer }) => {
  const [ext, web] = await Promise.all([extensionPeer("two-tabs-ring"), webPeer("two-tabs-ring-contact")]);
  await pair(web, ext);
  const second = { ...ext, page: await ext.context.newPage() };
  await second.page.goto(ext.page.url());
  await expect(chat(second)).toBeVisible({ timeout: 30_000 });
  // A click in each tab starts its audio: both can ring.
  for (const tab of [ext, second]) await chat(tab).click({ position: { x: 5, y: 5 } });
  const ringLocks = () => ext.page.evaluate(async () => {
    const { held = [], pending = [] } = await navigator.locks.query();
    const ring = (locks: LockInfo[]) => locks.filter((lock) => lock.name === "ghostly-ring:ring").length;
    return { held: ring(held), pending: ring(pending) };
  });

  await web.page.getByTestId("call-audio").click();
  for (const tab of [ext, second]) await expect(tab.page.getByText("Incoming audio call...")).toBeVisible({ timeout: 30_000 });
  await expect.poll(ringLocks, { timeout: 10_000 }).toEqual({ held: 1, pending: 1 });

  await web.page.getByTitle("End call").click();
  for (const tab of [ext, second]) await expect(tab.page.getByText("Incoming audio call...")).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(ringLocks, { timeout: 10_000 }).toEqual({ held: 0, pending: 0 });
});

/**
 * Each tab tells the peer which chat it shows, and the chat on screen carries its connection story in every state the
 * peer sends to every tab. A closed tab says nothing first: its chat stayed on screen for the peer until the last tab
 * closed, read 3x as often while its contact was away, its story still sent to the tabs left. It goes with the tab now.
 */
test("a chat on screen in a tab that closes is no longer on screen for the tabs left", { tag: ["@client:extension", "@client:web", "@feature:extension.engine"] }, async ({ extensionPeer, webPeer }) => {
  const [ext, web] = await Promise.all([extensionPeer("two-tabs-on-screen"), webPeer("two-tabs-on-screen-contact")]);
  await pair(web, ext);
  await expect(chat(ext)).toBeVisible({ timeout: 30_000 });
  // A tab on the chat list, which hears every state the peer sends: whether a chat in it carries its story.
  const list = await ext.context.newPage();
  await list.addInitScript(() => {
    type State = { kind?: string; state?: { links?: { transportHistory?: unknown }[] } };
    type Port = { onMessage: { addListener(listener: (message: State) => void): void } };
    const page = globalThis as unknown as { __storyShown?: boolean; chrome: { runtime: { connect: (...args: unknown[]) => Port } } };
    const runtime = page.chrome.runtime, connect = runtime.connect.bind(runtime);
    runtime.connect = (...args: unknown[]) => {
      const port = connect(...args);
      port.onMessage.addListener((message) => {
        if (message?.kind === "state" && message.state?.links) page.__storyShown = message.state.links.some((link) => link.transportHistory !== undefined);
      });
      return port;
    };
  });
  await list.goto(ext.page.url().replace(/#.*$/, "#/"));
  await expect(list.getByTitle("New Chat")).toBeVisible({ timeout: 30_000 });
  const storyShown = () => list.evaluate(() => (globalThis as unknown as { __storyShown?: boolean }).__storyShown);
  await expect.poll(storyShown, { timeout: 30_000 }).toBe(true);

  await ext.page.close();
  // The tabs left hear a state as the closed tab's chat leaves the screen, and none carries its story any more.
  await expect.poll(storyShown, { timeout: 30_000 }).toBe(false);
});

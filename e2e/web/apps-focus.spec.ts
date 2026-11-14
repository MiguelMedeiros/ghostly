import { expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { STORE_URL, serveStore, testStore } from "../support/appStore";
import type { Frame, Locator, Page } from "@playwright/test";

/*
 * An app beside a 1:1 chat and the keyboard (WISP 1200 § The runner and the broker, The focus), in a real browser: Ana
 * installs an app from a store routed in the test, opens it beside her chat with Bob and types 300 keys in the message
 * field, 30 to 90 ms apart, as a person does. An app that takes the focus by script again and again is stopped at the
 * third time, gets at most a key of each of its first two tries, and its panel says why. An app that focuses its own field once keeps running, and a
 * click or a Tab into it still works.
 */

const KEYS = 300;
const TEXT = "the quick brown fox jumps over the lazy dog and then it naps; ".repeat(10).slice(0, KEYS);

/**
 * The app: a field and a button. It counts the keys it hears (told to the test as they come, since its frame may be gone
 * by the end), and takes the focus the way `mode` says: `loop` as fast as tasks run, `timer` every 150 ms.
 */
const APP = `<!doctype html><meta charset=utf-8><title>Notes</title><body><h1>Notes</h1><input data-testid=note><button data-testid=more>More</button>
<script>
const note = document.querySelector("input");
window.keys = 0; window.clicks = 0; window.mode = "";
document.addEventListener("keydown", (e) => { if (e.key.length !== 1) return; window.keys++; try { window.appHeard && window.appHeard(window.keys); } catch (e) {} }, true);
document.querySelector("button").onclick = () => window.clicks++;
setInterval(() => { if (window.mode === "timer") note.focus(); }, 150);
window.startLoop = () => { const c = new MessageChannel(); c.port1.onmessage = () => { if (window.mode !== "loop") return; note.focus(); c.port2.postMessage(0); }; c.port2.postMessage(0); };
</script>`;

type AppWindow = { keys: number; clicks: number; mode: string; startLoop: () => void };

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

/** Ana with Notes open beside her chat with Bob, the message field focused. `heard()`: the keys the app got so far. */
async function setUp(peer: (name: string) => Promise<Peer>): Promise<{ page: Page; app: Locator; frame: Frame; field: Locator; heard: () => number }> {
  const store = await testStore({ title: "Notes", tagline: "A page to write on", entry: APP });
  const [ana, bob] = await Promise.all([peer("ana"), peer("bob")]);
  let keys = 0;
  await ana.context.exposeFunction("appHeard", (n: number) => { keys = Math.max(keys, n); });
  await serveStore(ana.context, store);
  await setNickname(ana, "Ana");
  await setNickname(bob, "Bob");
  const page = ana.page;
  await page.getByTestId("account-apps").click();
  await page.getByTestId("apps-add").click();
  await page.getByTestId("apps-add-url").fill(STORE_URL);
  await page.getByTestId("apps-add-check").click();
  await page.getByTestId("apps-add-store-confirm").click();
  await page.getByTestId("app-store").filter({ hasText: store.storeName }).getByTestId("app-listing-install").click();
  await page.getByTestId("app-install").getByTestId("app-install-confirm").click();
  await expect(page.getByTestId("installed-app")).toContainText("Notes");
  await page.goto("/#/");
  await pair(ana, bob);
  await page.setViewportSize({ width: 1280, height: 800 });
  await (await composerRow(page, "composer-apps")).click();
  await page.getByTestId("chat-apps").getByTestId("chat-app-open").click();
  const app = page.getByTestId("mini-app");
  await expect(app).toHaveAttribute("data-place", "beside");
  await expect(app.frameLocator("iframe").getByTestId("note")).toBeVisible();
  const frame = page.frames().find((f) => f.url().includes("app-frame"))!;
  const field = page.getByPlaceholder("Message…");
  const box = (await field.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await field.click();
  return { page, app, frame, field, heard: () => keys };
}

/** One key, then the pause of a person typing. */
async function key(page: Page, ch: string): Promise<void> {
  await page.keyboard.type(ch);
  await page.waitForTimeout(30 + Math.floor(Math.random() * 60));
}

const TAKEOVERS: { name: string; mode: "loop" | "timer"; pointer: "field" | "page" | "app" }[] = [
  { name: "in a tight loop", mode: "loop", pointer: "field" },
  { name: "every 150 ms, the pointer elsewhere on the page", mode: "timer", pointer: "page" },
  { name: "every 150 ms, the pointer coming to rest on the app halfway", mode: "timer", pointer: "app" },
];

for (const { name, mode, pointer } of TAKEOVERS) {
  test(`an app that keeps taking the keyboard (${name}) is stopped at the third time, and the keys typed in the message field stay there`, { tag: ["@feature:apps.view", "@feature:apps.web-sandbox"] }, async ({ peer }) => {
    test.setTimeout(240_000);
    const { page, app, frame, field, heard } = await setUp(peer);
    if (pointer !== "field") await page.mouse.move(300, 200, { steps: 3 });
    await frame.evaluate((m) => {
      const w = window as unknown as AppWindow;
      w.mode = m;
      if (m === "loop") w.startLoop();
    }, mode);

    if (pointer === "app") {
      for (const ch of TEXT.slice(0, KEYS / 2)) await key(page, ch);
      // Where the app is, or was: its panel stays, with the stopped message.
      const box = (await app.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
      await page.waitForTimeout(1_500);
      for (const ch of TEXT.slice(KEYS / 2)) await key(page, ch);
    } else {
      for (const ch of TEXT) await key(page, ch);
    }

    await expect(app.getByTestId("mini-app-stopped")).toHaveText("Notes was stopped: it kept taking the keyboard");
    await expect(app.locator("iframe")).toHaveCount(0);
    await expect(app.getByTestId("mini-app-open-again")).toHaveCount(0);
    const typed = await field.inputValue();
    console.log(`FOCUS ${JSON.stringify({ takeover: name, typed: KEYS, field: typed.length, appKeys: heard(), active: await page.evaluate(() => document.activeElement?.tagName), pageHasFocus: await page.evaluate(() => document.hasFocus()) })}`);
    // The two refusals before the stop give the focus back a task late (the browser is still moving it into the frame),
    // and a key typed in that instant reaches the app: at most one each (1 run in 10 on One). The app is stopped at the
    // third, so nothing after it.
    const lost = heard();
    expect(lost).toBeLessThanOrEqual(2);
    expect(typed.length).toBe(KEYS - lost);
    if (lost === 0) expect(typed).toBe(TEXT);
    // The page has the focus again (the browser took it for the frame that is gone), so the field shows its caret.
    await expect(field).toBeFocused();
  });
}

test("an app that focuses its own field once keeps running, and a click or a Tab into it still works", { tag: ["@feature:apps.view", "@feature:apps.web-sandbox"] }, async ({ peer }) => {
  test.setTimeout(240_000);
  const { page, app, frame, field, heard } = await setUp(peer);
  const inApp = app.frameLocator("iframe");
  await frame.evaluate(() => (document.querySelector("input") as HTMLInputElement).focus());
  for (const ch of TEXT.slice(0, 60)) await key(page, ch);
  expect(heard()).toBe(0);
  expect(await field.inputValue()).toBe(TEXT.slice(0, 60));
  await expect(field).toBeFocused();
  await expect(inApp.getByTestId("note")).toBeVisible();

  // A click on its field, then typing: the keys are the app's.
  const note = (await inApp.getByTestId("note").boundingBox())!;
  await page.mouse.click(note.x + 20, note.y + note.height / 2, { delay: 60 });
  await page.waitForTimeout(250);
  for (const ch of "note") await key(page, ch);
  await expect(inApp.getByTestId("note")).toHaveValue("note");

  // Back in the message field, then a click on its button: the first click counts.
  await field.click();
  await page.waitForTimeout(200);
  const more = (await inApp.getByTestId("more").boundingBox())!;
  await page.mouse.click(more.x + more.width / 2, more.y + more.height / 2, { delay: 60 });
  await expect.poll(() => frame.evaluate(() => (window as unknown as AppWindow).clicks)).toBe(1);

  // And by Tab, the pointer away from the app.
  await field.click();
  const before = heard();
  let tabs = 0;
  for (; tabs < 25 && (await page.evaluate(() => document.activeElement?.tagName)) !== "IFRAME"; tabs++) { await page.keyboard.press("Tab"); await page.waitForTimeout(60); }
  await page.waitForTimeout(400);
  for (const ch of "xyz") await key(page, ch);
  await expect.poll(() => heard() - before).toBe(3);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("IFRAME");

  // Still running: nothing of this was counted against it.
  await expect(app.getByTestId("mini-app-stopped")).toHaveCount(0);
  await expect(inApp.getByTestId("note")).toBeVisible();
  console.log(`FOCUS ${JSON.stringify({ takeover: "one focus at start", field: (await field.inputValue()).length, appKeysWhileInField: 0, tabs, running: !frame.isDetached() })}`);
});

import type { Page } from "@playwright/test";
import { copyInvite } from "../support/clipboard";
import { chat, expect, link, say, test, type Peer } from "../support/fixtures";

/** Chats kept by this browser, counted the way the app stores them. */
const storedChats = (page: Page) =>
  page.evaluate(
    () =>
      Object.keys(localStorage).filter((key) => {
        try {
          const value = JSON.parse(localStorage.getItem(key) ?? "");
          return key.startsWith("ghostly_") && value?.mySeedB64 && value?.peerPubKeyB64;
        } catch {
          return false;
        }
      }).length,
  );

/** `pair1/<seed>/<peer public key>/<encryption key>` */
function secrets(invite: string): { seed: string; peerKey: string; encKey: string } {
  const [, seed, peerKey, encKey] = invite.split("/");
  return { seed, peerKey, encKey };
}

async function newInvite(host: Peer): Promise<string> {
  await host.page.getByTitle("New Chat").click();
  const invite = await copyInvite(host.page);
  expect(invite).toMatch(/^pair1\//);
  return invite;
}

/** Every address in this tab's history, walking back to the first and forward again. */
async function historyUrls(page: Page): Promise<string[]> {
  const length = await page.evaluate(() => history.length);
  const urls = [page.url()];
  for (let i = 1; i < length; i++) {
    await page.goBack();
    urls.push(page.url());
  }
  for (let i = 1; i < length; i++) await page.goForward();
  return urls;
}

test("an invite link loaded afresh stores the chat, and its keys leave the address bar and the history", async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  const invite = await newInvite(alice);
  const { seed, encKey } = secrets(invite);

  // Bob follows the link from somewhere else: a fresh load of the app.
  await bob.page.goto("about:blank");
  await bob.page.goto(`/#/chat/${invite}`);
  await expect(bob.page).toHaveURL(/#\/chat\/[0-9a-f]+$/);
  for (const secret of [seed, encKey, "pair1"]) expect(bob.page.url()).not.toContain(secret);
  await expect.poll(() => storedChats(bob.page)).toBe(1);
  await expect(bob.page.getByTitle("Delete chat")).toHaveCount(1);

  const urls = await historyUrls(bob.page);
  expect(urls.length).toBeGreaterThanOrEqual(2);
  for (const url of urls) {
    expect(url).not.toContain(seed);
    expect(url).not.toContain(encKey);
  }
  await expect(bob.page).toHaveURL(/#\/chat\/[0-9a-f]+$/);

  // The address it was given is the chat: it opens there, and it is a working chat.
  await bob.page.reload();
  await expect(bob.page.getByPlaceholder("Message…")).toBeVisible();
  for (const p of [alice, bob]) await expect(p.page.getByPlaceholder("Message…")).toBeEnabled();
  await say(bob, "came in through the link");
  await expect(chat(alice).getByText("came in through the link")).toBeVisible();
  await say(alice, "welcome in");
  await expect(chat(bob).getByText("welcome in")).toBeVisible();
  expect(await storedChats(bob.page)).toBe(1);
});

// The link is taken after the router listens, so a link opened in a new tab lands in its chat.
test("an invite link loaded afresh opens its chat at once", async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  const invite = await newInvite(alice);
  await bob.page.goto("about:blank");
  await bob.page.goto(`/#/chat/${invite}`);
  await expect(bob.page.getByPlaceholder("Message…")).toBeVisible();
  await expect(bob.page).toHaveURL(/#\/chat\/[0-9a-f]+$/);
});

test("an invite link opened inside a running app is taken the same way", async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  const invite = await newInvite(alice);
  const { seed } = secrets(invite);

  // Same document: only the fragment changes.
  await bob.page.evaluate((invite) => (location.hash = `/chat/${invite}`), invite);
  await expect(bob.page.getByPlaceholder("Message…")).toBeVisible();
  await expect(bob.page).toHaveURL(/#\/chat\/[^/]+$/);
  for (const url of await historyUrls(bob.page)) expect(url).not.toContain(seed);
  const chatUrl = bob.page.url();

  // The same link again goes to the same chat: no second one.
  await bob.page.goto("/#/");
  await bob.page.evaluate((invite) => (location.hash = `/chat/${invite}`), invite);
  await expect(bob.page).toHaveURL(chatUrl);
  expect(await storedChats(bob.page)).toBe(1);
  await expect(bob.page.getByTitle("Delete chat")).toHaveCount(1);

  for (const p of [alice, bob]) await expect(p.page.getByPlaceholder("Message…")).toBeEnabled();
  await say(alice, "one chat, not two");
  await expect(chat(bob).getByText("one chat, not two")).toBeVisible();
});

test("a link that is not an invite creates nothing and ends on the home screen", async ({ peer }) => {
  const bob = await peer("bob");
  for (const bad of ["not-an-invite", "pair1", "%E2%98%A0", "..%2F..%2Fsettings"]) {
    await bob.page.goto(`/#/chat/${bad}`);
    await expect(bob.page).toHaveURL(/#\/$/);
    await expect(bob.page.getByText("It's quiet here...")).toBeVisible();
  }
  expect(await storedChats(bob.page)).toBe(0);
  await expect(bob.page.getByTitle("Delete chat")).toHaveCount(0);
});

// A broken link says so, like the join dialog does.
test("a link that is not an invite says so", async ({ peer }) => {
  const bob = await peer("bob");
  await bob.page.goto("about:blank");
  await bob.page.goto("/#/chat/not-an-invite");
  await expect(bob.page.getByText(/invalid invite/i)).toBeVisible({ timeout: 10_000 });
});

// A damaged link is not a chat address either: it leaves the address and the history, keys and all.
test("a damaged invite link creates nothing and does not keep its keys in the address", async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  const invite = await newInvite(alice);
  const { seed } = secrets(invite);
  const damaged = invite.slice(0, -5);

  await bob.page.goto("about:blank");
  await bob.page.goto(`/#/chat/${damaged}`);
  await expect(bob.page.getByTitle("New Chat")).toBeVisible();
  await expect(bob.page).not.toHaveURL(new RegExp(seed));
  for (const url of await historyUrls(bob.page)) expect(url).not.toContain(seed);
  expect(await storedChats(bob.page)).toBe(0);
});

// Keys a stored chat already has, in another invite format, are refused without taking the app down.
test("the keys of a chat already here, in another invite format, do not take the app down", async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await bob.page.goto("/#/");
  const stored = await bob.page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? "");
        if (key.startsWith("ghostly_") && value?.mySeedB64) return value as { mySeedB64: string; peerPubKeyB64: string; encKeyB64: string };
      } catch {
        // not a chat
      }
    }
    return null;
  });
  expect(stored).not.toBeNull();
  // The same keys, without the `pair1/` prefix: a legacy invite.
  await bob.page.goto(`/#/chat/${stored!.mySeedB64}/${stored!.peerPubKeyB64}/${stored!.encKeyB64}`);
  await expect(bob.page.getByTitle("New Chat")).toBeVisible();
  await expect(bob.page).not.toHaveURL(new RegExp(stored!.mySeedB64));
  expect(await storedChats(bob.page)).toBe(1);
});

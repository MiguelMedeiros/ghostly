import { expect, link, test } from "../support/fixtures";
import { LocalRelay } from "../support/relay";

/**
 * A profile last used by a newer Ghostly. Reported 2026-10-02: a tester opened a profile with a development build
 * (its database moved to the next schema version) and later with the released app. IndexedDB does not open a database
 * below its stored version, so the engine never started; the page still drew the chat list from its own mirror, and
 * the app looked alive while it connected nobody, sent nothing and said nothing.
 */

/** The profile's database as a newer build would leave it: one schema version above whatever this build stored. */
const NEWER = 12;

test("a profile last used by a newer Ghostly says so in place of the chat list, starts nothing, and leaves its data as it is", { tag: ["@feature:app.profile-unavailable"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  const { page } = alice;
  // Alice has a chat: what the page's mirror draws a list from with no engine at all.
  await page.goto("/#/");
  await expect(page.getByTestId("sidebar").getByTestId("chat-row").first()).toBeVisible();

  // Off the app (its peer stops and lets go of the database), a newer build stores the profile at the next version.
  await page.goto("/manifest.json");
  const stored = await page.evaluate(async (wanted) => {
    const before = (await indexedDB.databases()).find((d) => d.name === "ghostly")?.version ?? 0;
    const version = Math.max(wanted, before + 1);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("ghostly", version);
      request.onupgradeneeded = () => { /* the stores stay as they are: only the version moves */ };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("the app still holds its database"));
    });
    return { before, version };
  }, NEWER);
  expect(stored.before).toBeGreaterThan(0);

  // From here on, whatever this page asks a relay is counted: an engine that started would publish and poll at once.
  const asked: string[] = [];
  alice.context.on("request", (request) => { if (LocalRelay.pattern.test(request.url())) asked.push(request.url()); });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  const notice = page.getByTestId("profile-unavailable");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("data-reason", "newer");
  await expect(notice).toContainText("This profile was last used by a newer version of Ghostly.");
  await expect(notice).toContainText("Update the app to open it.");
  // Nothing of the profile is on screen: no list that looks alive, no composer whose message would go nowhere.
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  await expect(page.getByTestId("chat-row")).toHaveCount(0);
  await expect(page.getByTitle("New Chat")).toHaveCount(0);
  await expect(page.getByPlaceholder("Message…")).toHaveCount(0);
  // And nothing offers to delete or reset it.
  await expect(notice.getByRole("button", { name: /delete|reset|clear|remove/i })).toHaveCount(0);

  // The versions are behind the ⓘ.
  await notice.getByTestId("profile-unavailable-info").click();
  await expect(notice.getByTestId("profile-unavailable-text")).toContainText(`This profile's data is at version ${stored.version}.`);
  await expect(notice.getByTestId("profile-unavailable-text")).toContainText(`reads up to version ${stored.before}.`);

  // A chat's own address shows the same, not the chat.
  await page.goto("/#/settings");
  await expect(notice).toBeVisible();
  await expect(page.getByRole("heading", { name: "Settings" })).toHaveCount(0);

  // No engine activity: several poll intervals pass and the relays heard nothing from this page.
  await page.waitForTimeout(6_000);
  expect(asked).toEqual([]);
  expect(errors).toEqual([]);
  // Never deleted, reset or downgraded: the newer build finds its profile, and the page's mirror is still there.
  const after = await page.evaluate(async () => ({
    version: (await indexedDB.databases()).find((d) => d.name === "ghostly")?.version,
    sessions: Object.keys(localStorage).filter((key) => /^ghostly_[^_]+$/.test(key)).length,
  }));
  expect(after.version).toBe(stored.version);
  expect(after.sessions).toBeGreaterThan(0);
});

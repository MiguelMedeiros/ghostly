import { chat, connect, expect, linkLegacy, say, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * Services on the web: a browser tab cannot reach a local web app, so sharing
 * one needs the extension or the desktop app. The web says so, offers nothing
 * it cannot do, and does not fall over when a contact shares nothing.
 */

/** Every uncaught error this page throws from here on. */
function errors(p: Peer): string[] {
  const seen: string[] = [];
  p.page.on("pageerror", (error) => seen.push(error.message));
  return seen;
}

test("the Services page on the web explains sharing needs the extension, and offers no add", { tag: ["@feature:services.web-unavailable", "@feature:app.web-limits"] }, async ({ peer }) => {
  const alice = await peer("services-web");
  const thrown = errors(alice);
  await alice.page.getByTestId("account-services").click();
  const page = alice.page.getByTestId("my-services");
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();

  await expect(page.getByTestId("your-apps")).toContainText("Sharing a local web app needs the Ghostly browser extension or desktop app.");
  await expect(page.getByTestId("add-service")).toHaveCount(0);
  await expect(page.getByText("Share a local service")).toHaveCount(0);
  await expect(page.getByTestId("service-name")).toHaveCount(0);
  await expect(page.getByTestId("service-item")).toHaveCount(0);
  // Nothing from contacts either, and it says where that would show up.
  await expect(page.getByTestId("contact-services")).toContainText("Apps your contacts share show up here.");
  await expect(page.getByTestId("contact-service-open")).toHaveCount(0);

  await page.getByRole("button", { name: "Back" }).click();
  await expect(alice.page.getByTestId("my-services")).toHaveCount(0);
  expect(thrown).toEqual([]);
});

test("a paired chat's Services… dialog on the web explains the same, and closes", { tag: ["@feature:services.web-unavailable", "@feature:app.web-limits", "@feature:app.popovers"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("svc-dialog-alice"), peer("svc-dialog-bob")]);
  const thrown = [...[alice, bob].map(errors)];
  await pair(alice, bob);
  await say(alice, "nothing to share here");
  await expect(chat(bob).getByText("nothing to share here")).toBeVisible();

  // A contact that shares nothing puts no apps strip over a paired chat.
  for (const p of [alice, bob]) await expect(p.page.getByTestId("peer-services")).toHaveCount(0);

  for (const p of [alice, bob]) {
    await p.page.getByTestId("chat-options").click();
    await p.page.getByTestId("chat-services-open").click();
    const dialog = p.page.getByTestId("chat-services");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: /^Apps with / })).toBeVisible();
    await expect(dialog).toContainText("Needs the extension or desktop app.");
    // Nothing on the web to add, nor to grant.
    await expect(dialog.getByText("+ Add an app")).toHaveCount(0);
    await expect(dialog.getByTestId("chat-service-toggle")).toHaveCount(0);
    await expect(dialog).toContainText("Nothing shared with you.");
    await expect(dialog.getByTestId("chat-service-open")).toHaveCount(0);

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(p.page.getByPlaceholder("Message…")).toBeEnabled();
  }

  // A click beside it closes it as well.
  await alice.page.getByTestId("chat-options").click();
  await alice.page.getByTestId("chat-services-open").click();
  await expect(alice.page.getByTestId("chat-services")).toBeVisible();
  await alice.page.mouse.click(5, 5);
  await expect(alice.page.getByTestId("chat-services")).toHaveCount(0);

  // The chat carries on as before.
  await say(bob, "still talking");
  await expect(chat(alice).getByText("still talking")).toBeVisible();
  expect(thrown.flat()).toEqual([]);
});

test("an older chat's apps strip on the web: Manage opens the same explanation", { tag: ["@feature:services.web-unavailable", "@feature:app.web-limits"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("svc-strip-alice"), peer("svc-strip-bob")]);
  const thrown = [...[alice, bob].map(errors)];
  await linkLegacy(alice, bob);
  await connect(alice, bob);

  const strip = alice.page.getByTestId("peer-services");
  await expect(strip.getByTestId("datalink-state")).toHaveText("Peer to peer");
  // Nothing to open from a contact who shares nothing.
  await expect(strip.getByTestId("open-service")).toHaveCount(0);
  await expect(strip.getByTestId("grant-services")).toContainText("Share an app");

  await strip.getByTestId("grant-services").click();
  const dialog = alice.page.getByTestId("chat-services");
  await expect(dialog).toContainText("Needs the extension or desktop app.");
  await expect(dialog).toContainText("Nothing shared with you.");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);

  // And the Services page knows of no apps from this contact.
  await alice.page.getByTestId("account-services").click();
  await expect(alice.page.getByTestId("contact-services")).toContainText("Apps your contacts share show up here.");
  expect(thrown.flat()).toEqual([]);
});

/** The menu item that opened the dialog is gone once it opens: focus moves into the dialog, so Escape works. */
test("Escape closes a chat's Services… dialog", { tag: ["@feature:app.popovers"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("svc-escape-alice"), peer("svc-escape-bob")]);
  await pair(alice, bob);
  await alice.page.getByTestId("chat-options").click();
  await alice.page.getByTestId("chat-services-open").click();
  await expect(alice.page.getByTestId("chat-services")).toBeVisible();
  await alice.page.keyboard.press("Escape");
  await expect(alice.page.getByTestId("chat-services")).toHaveCount(0);
});

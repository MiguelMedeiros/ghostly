import type { BrowserContext, Page } from "@playwright/test";
import { copyInvite } from "../support/clipboard";
import { chat, expect, openProfilePage, test } from "../support/fixtures";

/*
 * A new profile asks once "What should people call you?" (apps/ui/src/components/NameStep.tsx): the field empty, and
 * Skip keeps the anonymous label. The suites run in an automated browser, where it is never asked; these specs turn it
 * on with the test switch. NAME_STEP_SHOTS=<dir> keeps a picture of it on a wide screen and on a phone.
 */

async function askForName(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => { try { localStorage.setItem("ghostly-test-name-step", "on"); } catch { /* opaque origin */ } });
}

async function shot(page: Page, name: string) {
  const dir = process.env.NAME_STEP_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

test("a new profile asks once what people should call it, and keeps the name", { tag: ["@feature:profiles.name-step", "@feature:settings.nickname"] }, async ({ peer }) => {
  const { page } = await peer("name-step", { beforeOpen: askForName });
  const step = page.getByTestId("name-step");
  await expect(step).toBeVisible();
  await expect(step.getByRole("heading", { name: "What should people call you?" })).toBeVisible();
  const input = page.getByTestId("name-step-input");
  await expect(input, "the field is empty: a placeholder, not a value").toHaveValue("");
  await expect(input).toHaveAttribute("placeholder", "Your name");
  await expect(page.getByTestId("name-step-save")).toBeDisabled();
  await expect(input, "the field has the focus, ready to type").toBeFocused();
  await shot(page, "desktop");
  await input.fill("Casper");
  await input.press("Enter");
  await expect(step).toBeHidden();
  await expect(page.getByTestId("sidebar-new-chat"), "the focus goes on to New, not the page's body").toBeFocused();
  await openProfilePage(page);
  await expect(page.getByTestId("account-nickname")).toHaveValue("Casper");
  // Asked once.
  await page.reload();
  await expect(page.getByTestId("account-nickname")).toHaveValue("Casper");
  await expect(step).toHaveCount(0);

  // A new profile made here asks too; the one it came from keeps its name.
  await page.getByTestId("profile-new").click();
  await page.getByTestId("profile-new-name").fill("Work");
  await page.getByTestId("profile-create").click();
  await expect(page.getByTestId("profile-name")).toHaveValue("Work", { timeout: 30000 });
  await expect(step).toBeVisible();
  await page.getByTestId("name-step-skip").click();
  await expect(step).toBeHidden();
  await expect(page.getByTestId("account-nickname")).toHaveValue("");
});

test("on a phone, Skip keeps the anonymous label and is not asked again", { tag: ["@feature:profiles.name-step"] }, async ({ peer }) => {
  const { page } = await peer("name-step-phone", { mobile: true, beforeOpen: askForName });
  const step = page.getByTestId("name-step");
  await expect(step).toBeVisible();
  await expect(page.getByTestId("name-step-input")).toHaveValue("");
  await shot(page, "phone");
  await page.getByTestId("name-step-skip").click();
  await expect(step).toBeHidden();
  await expect(page.getByTestId("sidebar-new-chat")).toBeFocused();
  await page.reload();
  await expect(page.getByTitle("New Chat")).toBeVisible();
  await expect(step).toHaveCount(0);
  await page.goto("/#/profile");
  await expect(page.getByTestId("account-nickname")).toHaveValue("");
});

// A link that reaches the tab while it asks (another tab forwards it, the installed app's launch puts it in the address:
// `location.hash = link` both) is no answer: the step stays over the chat it opened, with the name typed, as on a first
// visit with the link, and the inviter sees that name.
test("a chat link that reaches the tab while it asks leaves the question open, and the name typed", { tag: ["@feature:profiles.name-step", "@feature:invite.link"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob", { beforeOpen: askForName })]);
  const step = bob.page.getByTestId("name-step");
  await expect(step).toBeVisible();
  await bob.page.getByTestId("name-step-input").fill("Guest G");
  await alice.page.getByTitle("New Chat").click();
  const code = (await copyInvite(alice.page)).split("#")[1];

  await bob.page.evaluate((code) => { location.hash = code; }, code);
  await expect(bob.page).toHaveURL(/#\/chat\/[0-9a-f]+$/);
  await expect(step, "still asked").toBeVisible();
  await expect(bob.page.getByTestId("name-step-input")).toHaveValue("Guest G");
  expect(await bob.page.evaluate(() => localStorage.getItem("ghostly_name_step"))).toBe("ask");

  await bob.page.getByTestId("name-step-save").click();
  await expect(step).toBeHidden();
  await expect(chat(alice).getByText(/Guest G joined the chat/).first()).toBeVisible({ timeout: 60000 });
});

test("an automated run with no switch is never asked", { tag: ["@feature:profiles.name-step"] }, async ({ peer }) => {
  const { page } = await peer("name-step-off");
  await expect(page.getByTitle("New Chat")).toBeVisible();
  await expect(page.getByTestId("name-step")).toHaveCount(0);
});

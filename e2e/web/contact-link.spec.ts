import { chat, expect, say, test, type Peer } from "../support/fixtures";

/*
 * A contact link (WISP 8xx): one link that names nobody. Someone opens it and sends a request; the owner sees it in
 * Requests, apart from the chats, and accepts it (an ordinary chat starts) or declines it (nothing is said back).
 * Everything through the Pkarr relay in this process.
 */

/** The owner's contact link, made in Settings → Profile. */
async function makeLink(owner: Peer): Promise<string> {
  await owner.page.goto("/#/settings/profile");
  await owner.page.getByTestId("contact-link-create").click();
  const link = (await owner.page.getByTestId("contact-link-url").textContent()) ?? "";
  expect(link).toMatch(/^https:\/\/ghostly\.tools\/#ghostly1r[02-9ac-hj-np-z]{58}$/);
  return link.split("#")[1];
}

/** `asker` opens the link and sends a request with this name and text; the chat made for it opens. */
async function ask(asker: Peer, code: string, name: string, text: string): Promise<void> {
  await asker.page.goto("about:blank");
  await asker.page.goto(`/#${code}`);
  const form = asker.page.getByTestId("contact-ask");
  await expect(form).toBeVisible();
  await form.getByTestId("contact-ask-name").fill(name);
  await form.getByTestId("contact-ask-text").fill(text);
  await form.getByTestId("contact-ask-send").click();
  await expect(asker.page.getByTestId("asked-notice")).toBeVisible({ timeout: 30_000 });
  expect(asker.page.url()).not.toContain(code);
}

/** The owner's Requests, opened from above the chat list, once `name`'s request is there. */
async function requestFrom(owner: Peer, name: string) {
  await owner.page.goto("/#/");
  await owner.page.getByTestId("sidebar-requests").click();
  const request = owner.page.getByTestId("request").filter({ hasText: name });
  await expect(request).toBeVisible({ timeout: 90_000 });
  return request;
}

test("open the link, send a request, the owner accepts, and the chat carries text both ways", async ({ peer }) => {
  test.setTimeout(240_000);
  const owner = await peer("Owner");
  const kevin = await peer("Kevin");
  const code = await makeLink(owner);

  await ask(kevin, code, "Kevin", "Hi! I found you on your site.");
  // Nothing of the request reaches the owner's chat list: it waits in Requests.
  const request = await requestFrom(owner, "Kevin");
  await expect(request.getByTestId("request-text")).toHaveText("Hi! I found you on your site.");
  await expect(owner.page.getByTestId("chat-list")).not.toContainText("Kevin");

  await request.getByTestId("request-accept").click();
  await expect(chat(owner)).toContainText("Hi! I found you on your site.", { timeout: 30_000 });
  await expect(kevin.page.getByTestId("asked-notice")).toHaveCount(0, { timeout: 120_000 });
  await say(owner, "Hello Kevin, welcome.");
  await expect(chat(kevin)).toContainText("Hello Kevin, welcome.", { timeout: 90_000 });
  await say(kevin, "Thanks!");
  await expect(chat(owner)).toContainText("Thanks!", { timeout: 90_000 });
});

test("a declined request hears nothing, and the owner's Requests is empty again", async ({ peer }) => {
  test.setTimeout(240_000);
  const owner = await peer("Owner");
  const mallory = await peer("Mallory");
  const code = await makeLink(owner);

  await ask(mallory, code, "Mallory", "Let me in");
  const request = await requestFrom(owner, "Mallory");
  await request.getByTestId("request-decline").click();
  await expect(owner.page.getByTestId("requests-empty")).toBeVisible();
  // The requester learns its request arrived, never what became of it.
  await expect(mallory.page.getByTestId("asked-notice")).toHaveAttribute("data-state", "seen", { timeout: 90_000 });
  await mallory.page.waitForTimeout(5_000);
  await expect(mallory.page.getByTestId("asked-notice")).toHaveAttribute("data-state", "seen");
  await expect(owner.page.getByTestId("chat-list")).not.toContainText("Mallory");
});

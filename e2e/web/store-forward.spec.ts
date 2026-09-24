import { chat, connect, expect, GIF, link, say, test, type Peer } from "../support/fixtures";
import { signS3 } from "../../packages/browser/src/backup/s3";

/**
 * Store-and-forward for an away contact (WISP 4xx, `hold/1`): what Alice sends while Bob's page is
 * closed waits in her own S3 storage, sealed for him, and reaches him in order when he is back. Opt-in:
 * a disposable local S3 server (MinIO) on GHOSTLY_S3_ENDPOINT, as the backup test uses.
 */
const endpoint = process.env.GHOSTLY_S3_ENDPOINT ?? "";
const credentials = { region: "us-east-1", accessKeyId: process.env.GHOSTLY_S3_KEY ?? "", secretAccessKey: process.env.GHOSTLY_S3_SECRET ?? "" };
const bucket = `ghostly-saf-${Date.now()}`;

const openHold = async (p: Peer) => { await p.page.getByTitle("Options").click(); await p.page.getByTestId("chat-hold-open").click(); return p.page.getByTestId("chat-hold"); };
async function holdOn(p: Peer) {
  const dialog = await openHold(p);
  await dialog.getByTestId("chat-hold-toggle").click();
  await dialog.getByTestId("chat-hold-save").click();
  await expect(dialog).toHaveCount(0);
}
const held = (p: Peer, text: string) => chat(p).locator(".group").filter({ hasText: text });
/** Bob's page is closed and Alice's side has noticed: what she sends now is held. */
async function away(alice: Peer, bob: Peer): Promise<string> {
  const url = bob.page.url();
  await bob.page.close();
  await expect(alice.page.getByTestId("contact-status")).toHaveAttribute("aria-label", "Away · messages are held", { timeout: 60_000 });
  return url;
}
async function back(bob: Peer, url: string) {
  bob.page = await bob.context.newPage();
  await bob.page.goto(url);
  await expect(bob.page.getByPlaceholder("Message…")).toBeVisible();
}
/** A signed S3 request from the test, as the bucket's owner. */
const s3 = async (method: string, path: string, body?: Buffer) => {
  const url = new URL(`${endpoint}/${bucket}${path}`);
  return fetch(url, { method, headers: await signS3({ method, url, body: body ? new Uint8Array(body) : undefined }, credentials), body: body as BodyInit | undefined });
};

test("text, a picture and a request held for an away contact arrive in order; a changed item is refused; an expired one is dropped", async ({ peer }) => {
  test.skip(!endpoint.startsWith("http://127.0.0.1:"), "Requires a disposable local S3 server");
  test.setTimeout(6 * 60_000);
  expect((await s3("PUT", "")).ok, "test bucket").toBe(true);
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  // Alice's own storage, set up and proven from Profile → Backups; the chat is where she came from.
  await alice.page.getByTestId("account-profile").click();
  const backups = alice.page.getByTestId("profile-backups");
  await backups.getByTestId("s3-setup").click();
  await backups.getByTestId("s3-endpoint").fill(endpoint);
  await backups.getByTestId("s3-bucket").fill(bucket);
  await backups.getByTestId("s3-accessKeyId").fill(credentials.accessKeyId);
  await backups.getByTestId("s3-secretAccessKey").fill(credentials.secretAccessKey);
  await backups.getByTestId("s3-save").click();
  await expect(backups.getByTestId("backup-done")).toContainText("Connected", { timeout: 30_000 });
  await alice.page.goBack();
  await expect(chat(alice)).toBeVisible();

  // Both switch it on; each learns the other's choice on the open session.
  await holdOn(alice);
  await holdOn(bob);
  await expect(async () => {
    const dialog = await openHold(alice);
    await expect(dialog.getByTestId("chat-hold-contact")).toHaveText("Contact: allows it");
    await expect(dialog.getByTestId("chat-hold-storage")).toContainText("your S3 storage");
    await alice.page.keyboard.press("Escape");
  }).toPass({ timeout: 30_000 });
  // Ecash only in Alice's requests: a Lightning invoice would need a mint on the network.
  await alice.page.getByTitle("Options").click();
  await alice.page.getByTestId("chat-payments-open").click();
  await alice.page.getByTestId("chat-payments").getByTestId("chat-payments-lightning").click();
  await alice.page.getByTestId("chat-payments-save").click();

  // Bob leaves. Alice sends text, a picture and a request: each is held, and the chat says how much waits.
  const url = await away(alice, bob);
  await say(alice, "held while you were out");
  await expect(held(alice, "held while you were out").getByText("Held · waiting for your contact")).toBeVisible({ timeout: 30_000 });
  await alice.page.getByTestId("file-input").setInputFiles({ name: "ghost.gif", mimeType: "image/gif", buffer: GIF });
  await expect(held(alice, "ghost.gif").getByText("Held · waiting for your contact")).toBeVisible({ timeout: 30_000 });
  await alice.page.getByTestId("payment-button").click();
  await alice.page.getByTestId("payment-amount").fill("10");
  await alice.page.getByTestId("payment-request").click();
  await expect(held(alice, "You requested").getByText("Held · waiting for your contact")).toBeVisible({ timeout: 30_000 });
  await alice.page.keyboard.press("Escape");
  await expect(alice.page.getByTestId("hold-indicator")).toContainText("3 items held for");
  // Alice's bucket holds sealed objects only: nothing of the text, the picture's name or the request.
  const listing = await (await s3("GET", "?list-type=2")).text();
  expect(listing.match(/\.ghostly-held<\/Key>/g)).toHaveLength(4);
  for (const key of [...listing.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1])) {
    const object = await (await s3("GET", `/${key}`)).arrayBuffer();
    expect(Buffer.from(object).toString("latin1")).not.toMatch(/held while|ghost\.gif|Requested|mints/);
  }

  // Bob is back: everything, in the order it was sent, and Alice sees each one received.
  await back(bob, url);
  await expect(chat(bob).getByText("held while you were out")).toBeVisible({ timeout: 60_000 });
  await expect(chat(bob).getByTestId("file-bubble").filter({ hasText: "ghost.gif" }).getByRole("img", { name: "ghost.gif" })).toBeVisible();
  await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "Requests" })).toContainText("10");
  const order = await chat(bob).locator(".group").allTextContents();
  const at = (text: string) => order.findIndex((t) => t.includes(text));
  expect(at("held while you were out")).toBeGreaterThan(at("hello from"));
  expect(at("ghost.gif")).toBeGreaterThan(at("held while you were out"));
  expect(at("Requests")).toBeGreaterThan(at("ghost.gif"));
  for (const text of ["held while you were out", "ghost.gif", "You requested"]) await expect(held(alice, text).getByText("Received by peer")).toBeVisible({ timeout: 90_000 });
  await expect(alice.page.getByTestId("hold-indicator")).toHaveCount(0);
  await expect.poll(async () => ((await (await s3("GET", "?list-type=2")).text()).match(/\.ghostly-held<\/Key>/g) ?? []).length, { timeout: 60_000 }).toBe(0);
  // The session is back too: what is sent now goes live, and Bob's side keeps the held ones once.
  await expect(alice.page.getByTestId("contact-status")).toHaveAttribute("aria-label", "Connected", { timeout: 60_000 });
  await say(bob, "back and live");
  await expect(chat(alice).getByText("back and live")).toBeVisible();
  await bob.page.reload();
  await expect(chat(bob).getByText("held while you were out")).toHaveCount(1);

  // A held object changed in storage is refused by Bob, told to Alice as such, and never shown.
  const again = await away(alice, bob);
  await say(alice, "this one gets tampered");
  await expect(held(alice, "this one gets tampered").getByText("Held · waiting for your contact")).toBeVisible({ timeout: 30_000 });
  const keys = [...(await (await s3("GET", "?list-type=2")).text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).filter((k) => !k.endsWith("manifest.ghostly-held"));
  expect(keys).toHaveLength(1);
  const original = Buffer.from(await (await s3("GET", `/${keys[0]}`)).arrayBuffer());
  original[original.length - 2] ^= 0x01;
  expect((await s3("PUT", `/${keys[0]}`, original)).ok).toBe(true);
  await back(bob, again);
  await expect(held(alice, "this one gets tampered").getByText("Delivery unconfirmed")).toBeVisible({ timeout: 90_000 });
  await expect(held(alice, "this one gets tampered")).toContainText("refused this item");
  await expect(chat(bob).getByText("this one gets tampered")).toHaveCount(0);
  const dialog = await openHold(bob);
  await expect(dialog.getByTestId("chat-hold-refused")).toContainText("1 held item");
  await bob.page.keyboard.press("Escape");

  // An item nobody picks up within its lifetime (shortened to seconds here) is dropped, and Bob never sees it.
  await alice.page.evaluate(() => localStorage.setItem("ghostly-test-hold-ttl", "5000"));
  await alice.page.reload();
  await expect(alice.page.getByTestId("contact-status")).toHaveAttribute("aria-label", "Connected", { timeout: 60_000 });
  const once = await away(alice, bob);
  await say(alice, "nobody will read this in time");
  await expect(held(alice, "nobody will read this in time").getByText("Held · waiting for your contact")).toBeVisible({ timeout: 30_000 });
  await expect(held(alice, "nobody will read this in time")).toContainText("whole lifetime", { timeout: 90_000 });
  await back(bob, once);
  await expect(chat(bob).getByText("back and live")).toBeVisible();
  await expect(chat(bob).getByText("nobody will read this in time")).toHaveCount(0);
});

test("a contact whose app does not hold is unaffected: nothing is held, offline text still goes the old way", async ({ peer }) => {
  const [carol, dave] = await Promise.all([peer("carol"), peer("dave")]);
  await link(carol, dave);
  await connect(carol, dave);
  await holdOn(carol);
  const dialog = await openHold(carol);
  await expect(dialog.getByTestId("chat-hold-contact")).toHaveText("Contact: has it off, or needs an updated Ghostly");
  await expect(dialog.getByTestId("chat-hold-storage")).toContainText("not set up");
  await carol.page.keyboard.press("Escape");
  await expect(dave.page.getByTitle("Options")).toBeVisible();
  const url = dave.page.url();
  await dave.page.close();
  // Not "held": short text falls back to the DHT mailbox of WISP 403, exactly as before.
  await expect(carol.page.getByTestId("contact-status")).not.toHaveAttribute("aria-label", "Connected", { timeout: 60_000 });
  await say(carol, "old way while away");
  await expect(held(carol, "old way while away").getByText("Sent · waiting for receipt")).toBeVisible({ timeout: 30_000 });
  await expect(carol.page.getByTestId("hold-indicator")).toHaveCount(0);
  await back(dave, url);
  await expect(chat(dave).getByText("old way while away")).toBeVisible({ timeout: 60_000 });
  await expect(held(carol, "old way while away").getByText("Received by peer")).toBeVisible({ timeout: 60_000 });
});

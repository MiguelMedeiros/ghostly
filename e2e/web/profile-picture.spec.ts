import { chat, connect, expect, link, test, type Peer } from "../support/fixtures";

/** A real 300×200 JPEG with an EXIF segment carrying a marker, standing in for a photo's location. */
async function photoWithExif(peer: Peer): Promise<Buffer> {
  const bytes = await peer.page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 300; canvas.height = 200;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#e33"; context.fillRect(0, 0, 300, 200);
    context.fillStyle = "#33e"; context.fillRect(100, 0, 100, 200);
    const jpeg = atob(canvas.toDataURL("image/jpeg", 0.9).split(",")[1]);
    const exif = "Exif\0\0GHOSTLY-SECRET-GPS 52.37N 4.89E";
    const segment = String.fromCharCode(0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255) + exif;
    const withExif = jpeg.slice(0, 2) + segment + jpeg.slice(2);
    return Array.from(withExif, (c) => c.charCodeAt(0));
  });
  return Buffer.from(bytes);
}

const decoded = (peer: Peer, testId: string) =>
  chat(peer).page().getByTestId(testId).first().evaluate((img: HTMLImageElement) => atob(img.src.split(",")[1]));

test("a profile picture goes to paired contacts, without anything of the file, and can be removed", { tag: ["@feature:profiles.picture", "@feature:profiles.picture.sanitize"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  await expect(bob.page.getByTestId("chat-avatar")).toHaveCount(0);

  // Something that is not a picture is refused with a reason.
  await alice.page.getByTestId("account-profile").click();
  await alice.page.getByTestId("profile-avatar-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(alice.page.getByText("Choose a picture")).toBeVisible();

  await alice.page.getByTestId("profile-avatar-input").setInputFiles({ name: "holiday.jpg", mimeType: "image/jpeg", buffer: await photoWithExif(alice) });
  await expect(alice.page.getByTestId("profile-avatar-remove")).toBeVisible();
  await expect(alice.page.getByText("Choose a picture")).toHaveCount(0);
  // Alice sees it on her own account button.
  await expect(alice.page.getByTestId("account-profile").locator("img")).toBeVisible();

  // Bob sees it in the chat header and in his chat list, as a small square JPEG with no EXIF left.
  const header = bob.page.getByTestId("chat-avatar");
  await expect(header).toBeVisible({ timeout: 30_000 });
  await expect(bob.page.getByTestId("chat-row-avatar")).toBeVisible();
  expect(await header.getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
  expect(await header.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([128, 128]);
  const bytes = await decoded(bob, "chat-avatar");
  expect(bytes).not.toContain("GHOSTLY-SECRET-GPS");
  expect(bytes).not.toContain("Exif");

  // It stays with the chat after a reload.
  await bob.page.reload();
  await expect(bob.page.getByTestId("chat-avatar")).toBeVisible();
  // The side that stayed may take a while to notice the reload; removing is sent on the live session.
  await expect(bob.page.getByTestId("connection-options")).toHaveAttribute("aria-label", /Connected/, { timeout: 90_000 });

  // Removed: Bob is back to the initial.
  await alice.page.getByTestId("profile-avatar-remove").click();
  await expect(alice.page.getByTestId("account-profile").locator("img")).toHaveCount(0);
  await expect(bob.page.getByTestId("chat-avatar")).toHaveCount(0, { timeout: 30_000 });
  await expect(bob.page.getByTestId("chat-row-avatar")).toHaveCount(0);
});

test("a picture set while a contact is away reaches them when they come back", { tag: ["@feature:profiles.picture"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const url = bob.page.url();
  await bob.page.close();
  await alice.page.getByTestId("account-profile").click();
  await alice.page.getByTestId("profile-avatar-input").setInputFiles({ name: "me.jpg", mimeType: "image/jpeg", buffer: await photoWithExif(alice) });
  await expect(alice.page.getByTestId("profile-avatar-remove")).toBeVisible();
  bob.page = await bob.context.newPage();
  await bob.page.goto(url);
  await expect(bob.page.getByTestId("chat-avatar")).toBeVisible({ timeout: 60_000 });
});

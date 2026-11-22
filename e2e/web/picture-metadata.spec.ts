import { crc32 } from "node:zlib";
import type { Locator, Page } from "@playwright/test";
import { chat, connect, expect, link, openProfilePage, say, test, type Peer } from "../support/fixtures";

/**
 * A picture leaves without its metadata. A photo's file says where it was taken, the device and the time (Exif, XMP,
 * PNG text, WebP EXIF): Alice's app removes them before the picture is stored and sent, in a chat and in a group, so
 * what Bob receives is the picture alone, drawn at the same size and in the same colours. A picture whose metadata
 * cannot be removed is refused in the composer, and nothing of it reaches Bob.
 */

const SECRET = "GHOSTLY-SECRET-GPS 52.37N 4.89E";
/** What Alice draws: 300 × 200 of one colour. */
const COLOUR = [200, 40, 60];

/** A picture drawn in Alice's page, as its browser encodes it. */
async function drawn(page: Page, type: "image/jpeg" | "image/png" | "image/webp"): Promise<Buffer> {
  const data = await page.evaluate(({ type, colour }) => {
    const canvas = document.createElement("canvas");
    canvas.width = 300; canvas.height = 200;
    const context = canvas.getContext("2d")!;
    context.fillStyle = `rgb(${colour.join(",")})`;
    context.fillRect(0, 0, 300, 200);
    return canvas.toDataURL(type, 0.95);
  }, { type, colour: COLOUR });
  const bytes = Buffer.from(data.split(",")[1]!, "base64");
  expect(data.startsWith(`data:${type}`)).toBe(true);
  return bytes;
}

/** A JPEG with an Exif segment holding the secret, right after its start. */
function jpegWithExif(jpeg: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from("Exif\0\0MM\0*\0\0\0\x08\0\0\0\0\0\0", "latin1"), Buffer.from(SECRET, "latin1")]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, body, jpeg.subarray(2)]);
}

/** A PNG with a tEXt chunk holding the secret, right after IHDR. */
function pngWithText(png: Buffer): Buffer {
  const data = Buffer.from(`Comment\0${SECRET}`, "latin1");
  const body = Buffer.concat([Buffer.from("tEXt", "latin1"), data]);
  const length = Buffer.alloc(4), sum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  sum.writeUInt32BE(crc32(body));
  const afterIhdr = 8 + 12 + 13;
  return Buffer.concat([png.subarray(0, afterIhdr), length, body, sum, png.subarray(afterIhdr)]);
}

/** A WebP made extended (VP8X saying it has EXIF) with an EXIF chunk holding the secret after its image. */
function webpWithExif(webp: Buffer): Buffer {
  const riffChunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  let image = Buffer.from(webp.subarray(12));
  if (image.toString("latin1", 0, 4) === "VP8X") {
    // Already extended: its flags say EXIF too.
    image[8] = image[8]! | 0x08;
  } else {
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x08;
    vp8x.writeUIntLE(300 - 1, 4, 3);
    vp8x.writeUIntLE(200 - 1, 7, 3);
    image = Buffer.concat([riffChunk("VP8X", vp8x), image]);
  }
  const chunks = Buffer.concat([image, riffChunk("EXIF", Buffer.from(`MM\0*${SECRET}`, "latin1"))]);
  const head = Buffer.from("RIFF\0\0\0\0WEBP", "latin1");
  head.writeUInt32LE(4 + chunks.length, 4);
  return Buffer.concat([head, chunks]);
}

async function pictures(page: Page) {
  const [jpeg, png, webp] = await Promise.all([drawn(page, "image/jpeg"), drawn(page, "image/png"), drawn(page, "image/webp")]);
  const sent = [
    { name: "photo.jpg", mimeType: "image/jpeg", buffer: jpegWithExif(jpeg) },
    { name: "screenshot.png", mimeType: "image/png", buffer: pngWithText(png) },
    { name: "sticker.webp", mimeType: "image/webp", buffer: webpWithExif(webp) },
  ];
  for (const { buffer } of sent) expect(buffer.includes(SECRET)).toBe(true);
  return sent;
}

/** A picture as Bob's page has it: its bytes (as text, to look for the secret), its size and the colour at its middle. */
async function received(bubble: Locator, name: string) {
  const picture = bubble.getByRole("img", { name });
  await expect.poll(() => picture.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth), { timeout: 60_000 }).toBe(300);
  return picture.evaluate(async (img: HTMLImageElement) => {
    const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(img, 0, 0);
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return { text, size: [img.naturalWidth, img.naturalHeight], middle: [...context.getImageData(150, 100, 1, 1).data.slice(0, 3)] };
  });
}

async function expectClean(bubble: Locator, name: string): Promise<void> {
  const { text, size, middle } = await received(bubble, name);
  expect(text, name).not.toContain(SECRET);
  expect(text, name).not.toContain("Comment");
  expect(size, name).toEqual([300, 200]);
  for (const [i, value] of middle.entries()) expect(Math.abs(value - COLOUR[i]!), name).toBeLessThanOrEqual(6);
}

/** A JPEG cut before its end: a picture whose metadata cannot be removed. */
const cut = (jpeg: Buffer) => ({ name: "cut.jpg", mimeType: "image/jpeg", buffer: jpegWithExif(jpeg).subarray(0, jpegWithExif(jpeg).length - 40) });

test("a picture sent in a chat reaches the contact without its metadata, drawn the same; one whose metadata cannot be removed is refused", { tag: ["@feature:files.image.metadata"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const [alice, bob] = await Promise.all([peer("meta-alice"), peer("meta-bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  for (const file of await pictures(alice.page)) {
    await alice.page.getByTestId("file-input").setInputFiles(file);
    await expectClean(chat(bob).getByTestId("file-bubble").filter({ hasText: file.name }), file.name);
  }

  await alice.page.getByTestId("file-input").setInputFiles(cut(await drawn(alice.page, "image/jpeg")));
  await expect(alice.page.getByRole("alert")).toContainText("This picture cannot be sent: Ghostly could not remove the details saved in it");
  await expect(chat(alice).getByTestId("file-bubble").filter({ hasText: "cut.jpg" })).toHaveCount(0);
  // Sent after it, a text arrives; the refused picture never does.
  await say(alice, "after the cut one");
  await expect(chat(bob).getByText("after the cut one")).toBeVisible({ timeout: 30_000 });
  await expect(chat(bob).getByTestId("file-bubble").filter({ hasText: "cut.jpg" })).toHaveCount(0);
});

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

test("a picture sent in a group reaches its members without its metadata, drawn the same; one whose metadata cannot be removed is refused", { tag: ["@feature:files.image.metadata", "@feature:groups.files.compose"] }, async ({ peer }) => {
  test.setTimeout(8 * 60_000);
  const [alice, bob] = await Promise.all([peer("meta-group-alice"), peer("meta-group-bob")]);
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob")]);
  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Photos");
  await alice.page.getByTestId("new-group-create").click();
  const share = alice.page.getByTestId("group-share-dialog");
  const url = await share.getByTestId("group-link-url").inputValue();
  await share.getByTestId("group-share-done").click();
  await bob.page.goto(url);
  await expect(bob.page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 180_000 });
  await expect(alice.page.getByTestId("group-members")).toContainText("2 members", { timeout: 120_000 });

  const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
  for (const file of await pictures(alice.page)) {
    await groupChat(alice).getByTestId("file-input").setInputFiles(file);
    await expectClean(groupChat(bob).getByTestId("file-bubble").filter({ hasText: file.name }), file.name);
  }

  await groupChat(alice).getByTestId("file-input").setInputFiles(cut(await drawn(alice.page, "image/jpeg")));
  await expect(alice.page.getByRole("alert")).toContainText("This picture cannot be sent: Ghostly could not remove the details saved in it");
  await expect(groupChat(alice).getByTestId("file-bubble").filter({ hasText: "cut.jpg" })).toHaveCount(0);
  await expect(groupChat(bob).getByTestId("file-bubble").filter({ hasText: "cut.jpg" })).toHaveCount(0);
});

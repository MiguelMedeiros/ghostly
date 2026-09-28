import { crc32, deflateSync } from "node:zlib";
import { chat, connect, expect, link, test } from "../support/fixtures";

/**
 * A picture's bubble has its box before the picture loads: Alice's app reads the picture's size from its first bytes
 * and sends it with the file, and Bob's bubble is laid out at that size from the moment it appears, so nothing in the
 * chat moves when the picture shows.
 */

/** A plain PNG of this size, one colour, that a browser draws. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4), sum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7a)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(new Array(height).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}

test("a picture's bubble is as tall from the start as the picture it shows", { tag: ["@feature:files.image.box", "@feature:files.image.meta"] }, async ({ peer }) => {
  test.setTimeout(3 * 60_000);
  const [alice, bob] = await Promise.all([peer("box-alice"), peer("box-bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  // Every height Bob's picture box has had in the layout, from the moment it is in the page (a new message's entry
  // animation scales the bubble, which is not the layout moving).
  await bob.page.evaluate(() => {
    const seen: number[] = [];
    (window as unknown as { pictureHeights: number[] }).pictureHeights = seen;
    const note = () => {
      const box = document.querySelector<HTMLElement>("[data-testid='file-picture']");
      if (box) seen.push(box.offsetHeight);
    };
    new MutationObserver(note).observe(document.body, { childList: true, subtree: true, attributes: true });
  });

  await alice.page.getByTestId("file-input").setInputFiles({ name: "tall ghost.png", mimeType: "image/png", buffer: png(200, 600) });

  const bubble = chat(bob).getByTestId("file-bubble").filter({ hasText: "tall ghost.png" });
  const picture = bubble.getByRole("img", { name: "tall ghost.png" });
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth)).toBe(200);
  const box = bubble.getByTestId("file-picture");
  await expect(box).toHaveAttribute("data-box", "sized");
  expect(await box.evaluate((el) => el.style.aspectRatio)).toBe("200 / 600");
  // 200 × 600 fits 330 high: 110 × 330.
  expect(await box.evaluate((el) => [el.offsetWidth, el.offsetHeight])).toEqual([110, 330]);
  const heights = await bob.page.evaluate(() => (window as unknown as { pictureHeights: number[] }).pictureHeights);
  expect(heights.length).toBeGreaterThan(0);
  expect(new Set(heights)).toEqual(new Set([330]));

  // Alice's own bubble has its box at once too.
  const mine = chat(alice).getByTestId("file-bubble").filter({ hasText: "tall ghost.png" }).getByTestId("file-picture");
  await expect(mine).toHaveAttribute("data-box", "sized");
  expect(await mine.evaluate((el) => el.offsetHeight)).toBe(330);
});

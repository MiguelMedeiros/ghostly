import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * Forced colors (Windows Contrast themes) replace backgrounds with the page's: the invite QR's white box went with them,
 * and in a dark theme only the SVG's own 2-module margin stayed light, with the black page right after. A QR asks for a
 * 4-module light quiet zone; the code a new person is asked to scan keeps it, read from the pixels around the code.
 */

/** The pixels in the ring 4 modules wide around the code (its finder patterns' outer edge) that are not near white. */
async function darkAroundTheCode(page: Page): Promise<{ dark: number; total: number; module: number }> {
  const svg = page.getByTestId("invite-qr").locator("svg");
  const { box, module, margin } = await svg.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const width = Number(node.getAttribute("viewBox")!.split(" ")[2]);
    // The code's first dark module is its top left finder's corner: the SVG's own margin, in modules.
    const dark = node.querySelectorAll("path")[1].getAttribute("d")!;
    const margin = Number(dark.match(/^M\s*([\d.]+)/)![1]);
    return { box: { x: r.x, y: r.y, width: r.width, height: r.height }, module: r.width / width, margin };
  });
  const zone = 4 * module;
  const code = { x: box.x + margin * module, y: box.y + margin * module, width: box.width - 2 * margin * module, height: box.height - 2 * margin * module };
  const clip = { x: Math.floor(code.x - zone), y: Math.floor(code.y - zone), width: Math.ceil(code.width + 2 * zone), height: Math.ceil(code.height + 2 * zone) };
  const png = (await page.screenshot({ clip, scale: "css", animations: "disabled" })).toString("base64");
  // Inset by a pixel each side of the ring: the code's edge and the clip's rounding are not the quiet zone.
  const inner = { x: code.x - clip.x - 1, y: code.y - clip.y - 1, width: code.width + 2, height: code.height + 2 };
  return page.evaluate(async ({ png, inner }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    let dark = 0, total = 0;
    for (let y = 1; y < image.height - 1; y++) for (let x = 1; x < image.width - 1; x++) {
      if (x >= inner.x && x < inner.x + inner.width && y >= inner.y && y < inner.y + inner.height) continue;
      const i = (y * image.width + x) * 4;
      total++;
      if (Math.min(data[i], data[i + 1], data[i + 2]) < 230) dark++;
    }
    return { dark, total };
  }, { png, inner }).then((read) => ({ ...read, module }));
}

test("forced colors keep the invite QR's white quiet zone, 4 modules around the code", { tag: ["@feature:app.accessibility", "@feature:invite.qr.show"] }, async ({ peer }) => {
  const { page } = await peer("fc-qr");
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
  await page.getByTitle("New Chat").click();
  const qr = page.getByTestId("invite-qr");
  await expect(qr.locator("svg")).toBeVisible();

  const normal = await darkAroundTheCode(page);
  expect(normal.total).toBeGreaterThan(0);
  expect(normal.dark, `normal colours: dark pixels in the quiet zone (module ${normal.module} px)`).toBe(0);

  for (const [colorScheme, width] of [["dark", 1280], ["light", 375]] as const) {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ forcedColors: "active", colorScheme });
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    await qr.scrollIntoViewIfNeeded();
    const forced = await darkAroundTheCode(page);
    await qr.screenshot({ path: test.info().outputPath(`forced-qr-${colorScheme}.png`) });
    expect.soft(forced.dark, `forced colors ${colorScheme} at ${width} px: dark pixels in the quiet zone (module ${forced.module} px)`).toBe(0);
  }
});

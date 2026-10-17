import { writeFileSync } from "node:fs";
import { connect, expect, link, test } from "../support/fixtures";

test("an offer of a long name with nothing to break at stays inside its bubble on a phone", { tag: ["@feature:files.large.offer"] }, async ({ peer }, testInfo) => {
  test.setTimeout(120_000);
  const alice = await peer("alice");
  const bob = await peer("bob", { mobile: true });
  await link(alice, bob);
  await connect(alice, bob);

  // Over the 25 MiB a receiver takes without asking, so Bob is asked.
  const name = `report_final_${"x".repeat(120)}.bin`;
  const path = testInfo.outputPath(name);
  writeFileSync(path, Buffer.alloc(26 * 1024 * 1024, 7));
  await alice.page.getByTestId("file-input").setInputFiles(path);

  const offer = bob.page.getByTestId("file-offer");
  await expect(offer).toContainText(`wants to send ${name}`, { timeout: 60_000 });
  await offer.scrollIntoViewIfNeeded();
  // Where the offer's words end, against the bubble's edge and the screen's.
  const edges = await bob.page.evaluate(() => {
    const line = document.querySelector("[data-testid=file-offer] p")!;
    const range = document.createRange();
    range.selectNodeContents(line);
    return {
      text: range.getBoundingClientRect().right,
      bubble: document.querySelector("[data-testid=file-offer]")!.closest("[data-testid=file-bubble]")!.getBoundingClientRect().right,
      screen: document.documentElement.clientWidth,
    };
  });
  expect(edges.text, "the offer's text ends inside its bubble").toBeLessThanOrEqual(edges.bubble + 1);
  expect(edges.bubble).toBeLessThanOrEqual(edges.screen);
  await expect(offer).toContainText("(26.0 MB).");
});

test("a moving file's line on a phone shows its speed and time left whole", { tag: ["@feature:files.large.resume", "@feature:app.mobile-layout", "@feature:app.i18n"] }, async ({ peer }, testInfo) => {
  test.setTimeout(150_000);
  const alice = await peer("alice");
  const bob = await peer("bob", { mobile: true, viewport: { width: 375, height: 740 } });
  await link(alice, bob);
  await connect(alice, bob);
  await bob.page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language: "pt" }));
  });
  await bob.page.reload();
  await expect(bob.page.locator("html")).toHaveAttribute("lang", /^pt/);

  const path = testInfo.outputPath("relatorio.bin");
  writeFileSync(path, Buffer.alloc(30 * 1024 * 1024, 7));
  await alice.page.getByTestId("file-input").setInputFiles(path);
  const bubble = bob.page.getByTestId("file-bubble").last();
  await bubble.getByTestId("file-accept").click({ timeout: 60_000 });

  // "20% de 30.0 MB · 4.6 MB/s · menos de…": the line was cut at the bubble's width, and the time left with it.
  const status = bubble.getByTestId("file-status");
  const line = async () => status.evaluate((el) => ({ text: el.textContent ?? "", cut: el.scrollWidth > el.clientWidth + 1 }))
    .catch(() => ({ text: "", cut: false }));
  let seen = { text: "", cut: false };
  await expect.poll(async () => (seen = await line()).text, { timeout: 60_000, intervals: [50] }).toMatch(/\/s · /);
  expect(seen.cut, `"${seen.text}" is cut`).toBe(false);
  const [box, inside] = await Promise.all([bubble.boundingBox(), status.boundingBox()]);
  expect(inside!.x + inside!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
});

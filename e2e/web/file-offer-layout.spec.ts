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

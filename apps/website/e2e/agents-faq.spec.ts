import { expect, test } from "@playwright/test";
import { axe } from "./axe";
import { agentsFaq, plainAnswer } from "../content/agents-faq";

// /agents/faq: every question is a heading with its answer under it, and the page carries the same questions and
// answers, word for word and in order, as FAQPage data (JSON-LD) that search engines and agents read.

const PATH = "/agents/faq";

test("/agents/faq renders every question and its answer", async ({ page }) => {
  await page.goto(PATH);
  await expect(page).toHaveTitle("Agents FAQ | Ghostly");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Agents FAQ");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `https://ghostly.tools${PATH}`);
  expect(agentsFaq.items.length).toBeGreaterThanOrEqual(10);
  for (const item of agentsFaq.items) {
    const section = page.locator(`section#${item.id}`);
    await expect(section.getByRole("heading", { level: 2 })).toHaveText(item.q);
    await expect(section.locator("[data-answer]")).toHaveText(plainAnswer(item.a));
  }
  // No em dash or en dash in the copy (the site's rule; scripts/check-dashes.mjs reads the sources).
  expect(await page.locator("main").innerText()).not.toMatch(/[–—]/);
});

test("/agents/faq carries its questions and answers as FAQPage JSON-LD", async ({ page }) => {
  await page.goto(PATH);
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  const parsed = blocks.map((text) => JSON.parse(text) as { "@type"?: string });
  const faq = parsed.find((data) => data["@type"] === "FAQPage") as
    | { url: string; mainEntity: { "@type": string; name: string; acceptedAnswer: { "@type": string; text: string } }[] }
    | undefined;
  expect(faq, "a FAQPage block").toBeDefined();
  expect(faq!.url).toBe(`https://ghostly.tools${PATH}`);
  expect(faq!.mainEntity.map((q) => q["@type"])).toEqual(agentsFaq.items.map(() => "Question"));
  expect(faq!.mainEntity.map((q) => q.name)).toEqual(agentsFaq.items.map((item) => item.q));
  // Word for word what the page shows under each question.
  const shown = await page.locator("[data-answer]").allInnerTexts();
  expect(faq!.mainEntity.map((q) => q.acceptedAnswer.text)).toEqual(shown.map((text) => text.trim()));
  expect(faq!.mainEntity.every((q) => q.acceptedAnswer["@type"] === "Answer")).toBe(true);
});

test("the sitemap lists /agents/faq", async ({ request }) => {
  const xml = await (await request.get("/sitemap.xml")).text();
  expect(xml).toContain(`<loc>https://ghostly.tools${PATH}</loc>`);
});

test("/developers/agents links to /agents/faq", async ({ page }) => {
  await page.goto("/developers/agents");
  await expect(page.locator(`main a[href="${PATH}"]`)).toHaveText(/Agents FAQ/);
});

test("/agents/faq: axe finds nothing serious, wide or on a phone", async ({ page }) => {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 812 });
    await page.goto(PATH, { waitUntil: "networkidle" });
    expect(await axe(page), `${PATH} at ${width}px`).toEqual([]);
    const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(doc.sw, `${PATH} scrolls sideways at ${width}px`).toBeLessThanOrEqual(doc.cw);
  }
});

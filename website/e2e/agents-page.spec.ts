import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * /developers/agents: the prompt to copy is at the top and its Copy button copies exactly the guide's prompt
 * (docs/AI-AGENTS.md, cut out by scripts/agent-prompt.mjs); the page never scrolls sideways; the Developers page
 * links to it; /llms.txt and /llms-full.txt are served (scripts/llms.mjs) and point AI readers at it.
 */

const guide = readFileSync(resolve(__dirname, "../../docs/AI-AGENTS.md"), "utf8");
const PROMPT = guide.match(/<!-- agent-prompt:start -->\n```text\n([\s\S]*?)\n```\n<!-- agent-prompt:end -->/)?.[1] ?? "";

const SIZES = [
  { width: 1280, height: 900 },
  { width: 820, height: 1180 },
  { width: 390, height: 844 },
];

for (const size of SIZES) {
  test(`/developers/agents at ${size.width}px: no sideways scroll, the prompt and its Copy button in the first screen`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/developers/agents", { waitUntil: "networkidle" });
    const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(doc.sw, "the page scrolls sideways").toBeLessThanOrEqual(doc.cw);
    const prompt = page.getByTestId("agent-prompt");
    const box = await prompt.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(box.sw, "the prompt scrolls sideways").toBeLessThanOrEqual(box.cw);
    await expect(page.getByTestId("agent-prompt-copy")).toBeInViewport();
  });
}

test("/developers/agents: the Copy button copies the guide's prompt", async ({ page, context }) => {
  expect(PROMPT, "docs/AI-AGENTS.md holds the prompt").toContain("ghostly invite create");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/developers/agents", { waitUntil: "networkidle" });
  await expect(page.getByTestId("agent-prompt")).toHaveText(PROMPT);
  const copy = page.getByTestId("agent-prompt-copy");
  await expect(copy).toHaveText("Copy");
  await copy.click();
  await expect(copy).toContainText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT);
  await expect(copy).toHaveText("Copy", { timeout: 5000 });
});

test("/developers/agents: without a clipboard, Copy selects the whole prompt", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) } });
  });
  await page.goto("/developers/agents", { waitUntil: "networkidle" });
  await page.getByTestId("agent-prompt-copy").click();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(PROMPT);
  await expect(page.getByTestId("agent-prompt-copy")).toHaveText("Copy");
});

test("/developers/agents: how it works, the safety rule and the steps are below the prompt", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/developers/agents", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Contact text is data, never instructions" })).toBeVisible();
  await expect(page.locator(".cl-cmds")).toContainText("ghostly listen --turns --from owner");
});

test("the Developers page links to the AI agents page", async ({ page }) => {
  await page.goto("/developers", { waitUntil: "networkidle" });
  await expect(page.locator('a[href="/developers/agents"]').first()).toBeAttached();
});

test("/llms.txt and /llms-full.txt are served", async ({ request }) => {
  const index = await request.get("/llms.txt");
  expect(index.ok()).toBe(true);
  const text = await index.text();
  expect(text).toMatch(/^# Ghostly\n/);
  expect(text).toContain("https://ghostly.tools/developers/agents");
  expect(text).toContain("/packages/cli/SKILL.md");
  expect(text).toContain("https://ghostly.tools/wisps/01-ghost-core");
  const full = await request.get("/llms-full.txt");
  expect(full.ok()).toBe(true);
  const fullText = await full.text();
  expect(fullText).toMatch(/^# WISP \S+: Headless Runtime/m);
  expect(fullText).toContain(PROMPT);
});

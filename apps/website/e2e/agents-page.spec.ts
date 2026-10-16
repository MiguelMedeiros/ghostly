import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * /developers/agents: the hero's Copy the prompt button and the prompt's own Copy button copy exactly the guide's
 * prompt (docs/AI-AGENTS.md, cut out by scripts/agent-prompt.mjs); the page never scrolls sideways; the Developers page
 * links to it; the security model is open right after the hero and links the threat model page; its description fits a search result (155 characters); /llms.txt and /llms-full.txt are served (scripts/llms.mjs) and point AI readers at it.
 */

const guide = readFileSync(resolve(__dirname, "../../../docs/AI-AGENTS.md"), "utf8");
const PROMPT = guide.match(/<!-- agent-prompt:start -->\n```text\n([\s\S]*?)\n```\n<!-- agent-prompt:end -->/)?.[1] ?? "";

const SIZES = [
  { width: 1280, height: 900 },
  { width: 820, height: 1180 },
  { width: 390, height: 844 },
];

test("/developers/agents has a description short enough for a search result", async ({ page }) => {
  await page.goto("/developers/agents");
  const description = await page.locator('meta[name="description"]').getAttribute("content");
  expect(description?.length ?? 0).toBeGreaterThan(0);
  expect(description!.length).toBeLessThanOrEqual(155);
});

for (const size of SIZES) {
  test(`/developers/agents at ${size.width}px: no sideways scroll, the Copy the prompt button in the first screen`, async ({ page }) => {
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

for (const [id, label] of [["agent-prompt-copy", "Copy the prompt"], ["agent-prompt-box-copy", "Copy"]] as const) {
  test(`/developers/agents: ${label} (${id}) copies the guide's prompt`, async ({ page, context }) => {
    expect(PROMPT, "docs/AI-AGENTS.md holds the prompt").toContain("ghostly invite create");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/developers/agents", { waitUntil: "networkidle" });
    await expect(page.getByTestId("agent-prompt")).toHaveText(PROMPT);
    const copy = page.getByTestId(id);
    await expect(copy).toHaveText(label);
    await copy.click();
    await expect(copy).toContainText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT);
    await expect(copy).toHaveText(label, { timeout: 5000 });
  });
}

test("/developers/agents: without a clipboard, Copy selects the whole prompt", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) } });
  });
  await page.goto("/developers/agents", { waitUntil: "networkidle" });
  await page.getByTestId("agent-prompt-copy").click();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(PROMPT);
  await expect(page.getByTestId("agent-prompt-copy")).toHaveText("Copy the prompt");
});

test("/developers/agents: the security model comes right after the hero, open, before what a bot can show", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/developers/agents", { waitUntil: "networkidle" });
  const security = page.getByTestId("agent-security");
  await expect(security.getByRole("heading", { name: "Only you can give it work" })).toBeVisible();
  await expect(security).toContainText("ghostly listen --turns --from owner");
  await expect(security.getByRole("heading", { name: "The limit, said plainly" })).toBeVisible();
  const order = await page.evaluate(() => ["security", "fit", "show", "trust"].map((id) => document.getElementById(id)?.getBoundingClientRect().top ?? -1));
  expect(order.every((top, i) => top >= 0 && (i === 0 || top > order[i - 1])), `security, fit, show, trust in order: ${order}`).toBe(true);
  await expect(page.getByTestId("agent-trust").locator("a")).toHaveCount(6);
});

test("/developers/agents: how it works and the steps are below the prompt", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/developers/agents", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
  // The detail is folded under the picture (agents-steps.spec.ts).
  await page.getByTestId("agent-details").locator("summary").click();
  await expect(page.locator(".cl-cmds")).toContainText("ghostly listen --turns --from owner");
});

test("the threat model page: linked from the security model, its sections, no sideways scroll on a phone", async ({ page }) => {
  await page.goto("/developers/agents", { waitUntil: "networkidle" });
  await expect(page.getByTestId("agent-security").locator('a[href="/developers/agents/threat-model"]')).toBeAttached();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/developers/agents/threat-model", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("What a message can make your agent do");
  for (const id of ["threat-who", "threat-cannot", "threat-controls", "threat-limits", "threat-gaps"]) await expect(page.getByTestId(id)).toBeAttached();
  const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(doc.sw, "the page scrolls sideways").toBeLessThanOrEqual(doc.cw);
  const description = await page.locator('meta[name="description"]').getAttribute("content");
  expect(description!.length).toBeLessThanOrEqual(155);
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

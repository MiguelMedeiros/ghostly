import { expect, test } from "@playwright/test";

// /llms.txt and /llms-full.txt (scripts/llms.mjs, written into public/ by the sync before the build): what an AI agent
// reads first. Served as plain UTF-8 text, and linked from every page's head and footer.
test("llms.txt and llms-full.txt answer as plain UTF-8 text that starts with # Ghostly", async ({ request }) => {
  for (const path of ["/llms.txt", "/llms-full.txt"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()["content-type"], path).toMatch(/^text\/plain; charset=utf-8$/i);
    expect(await res.text(), path).toMatch(/^# Ghostly\n\n> /);
  }
});

test("every page links llms.txt in its head and its footer", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('head link[rel="alternate"][type="text/plain"]')).toHaveAttribute("href", "/llms.txt");
  await expect(page.locator("footer").getByRole("link", { name: "llms.txt", exact: true })).toHaveAttribute("href", "/llms.txt");
});

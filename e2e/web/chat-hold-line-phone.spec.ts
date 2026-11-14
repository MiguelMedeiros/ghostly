import type { BrowserContext, Page } from "@playwright/test";
import { connect, expect, link, test } from "../support/fixtures";

/**
 * On a 320 px phone the line above the composer that says what waits for an away contact (WISP 404) was one line cut
 * with "…": in Spanish "3 elementos guardados para Contacto · …" lost its quota ("… MB de … MB") at the end, 39 px of it.
 * It wraps onto a second line now.
 */

/** Alice's own storage: an S3 bucket in memory, answered in her browser, as the backup tests' MinIO would. */
const S3 = "http://127.0.0.1:9", BUCKET = "ghostly-hold-line";
async function memoryS3(context: BrowserContext) {
  const objects = new Map<string, Buffer>();
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, PUT, DELETE, HEAD", "access-control-expose-headers": "*" };
  await context.route(`${S3}/**`, async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const contents = [...objects].filter(([key]) => key.startsWith(prefix))
        .map(([key, bytes]) => `<Contents><Key>${key}</Key><Size>${bytes.length}</Size><LastModified>${new Date().toISOString()}</LastModified></Contents>`).join("");
      return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/xml" }, body: `<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>` });
    }
    const key = decodeURIComponent(url.pathname.slice(`/${BUCKET}/`.length));
    if (request.method() === "PUT") { objects.set(key, request.postDataBuffer() ?? Buffer.alloc(0)); return route.fulfill({ status: 200, headers: cors }); }
    if (request.method() === "DELETE") { objects.delete(key); return route.fulfill({ status: 204, headers: cors }); }
    const bytes = objects.get(key);
    return route.fulfill(bytes ? { status: 200, headers: cors, body: bytes } : { status: 404, headers: cors, body: "<Error><Code>NoSuchKey</Code></Error>" });
  });
}

const openHold = async (page: Page) => {
  await page.getByTestId("chat-options").click();
  // A phone's ⋮ keeps it under More…; a computer's has it in the menu itself.
  const more = page.getByTestId("chat-more-open");
  await expect(more.or(page.getByTestId("chat-hold-open"))).toBeVisible();
  if (await more.isVisible()) await more.click();
  await page.getByTestId("chat-hold-open").click();
  return page.getByTestId("chat-hold");
};
async function holdOn(page: Page) {
  const dialog = await openHold(page);
  await dialog.getByTestId("chat-hold-toggle").click();
  await dialog.getByTestId("chat-hold-save").click();
  await expect(dialog).toHaveCount(0);
}
/** Past the 256 bytes the DHT carries: longer text to an away contact is held. */
const LONG = " " + "and a few more words, to go past what the DHT carries. ".repeat(6);

test("on a 320 px phone the line of what is held for an away contact shows its whole sentence", { tag: ["@feature:delivery.hold.enable", "@feature:app.mobile-layout", "@feature:app.i18n"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const alice = await peer("alice", { mobile: true, viewport: { width: 320, height: 568 }, beforeOpen: memoryS3 });
  const bob = await peer("bob");

  // Alice's storage, set up and proven from Profile → Backups before she meets Bob.
  await alice.page.goto("/#/profile");
  const backups = alice.page.getByTestId("profile-backups");
  await backups.getByTestId("s3-setup").click();
  await backups.getByTestId("s3-endpoint").fill(S3);
  await backups.getByTestId("s3-bucket").fill(BUCKET);
  await backups.getByTestId("s3-accessKeyId").fill("test-key");
  await backups.getByTestId("s3-secretAccessKey").fill("test-secret");
  await backups.getByTestId("s3-save").click();
  await expect(backups.getByTestId("backup-done")).toContainText("Connected", { timeout: 30_000 });
  await alice.page.goto("/#/");

  await link(bob, alice);
  await connect(alice, bob);
  await holdOn(alice.page);
  await holdOn(bob.page);
  await expect(async () => {
    const dialog = await openHold(alice.page);
    await expect(dialog.getByTestId("chat-hold-contact")).toHaveText("Contact: allows it");
    await alice.page.keyboard.press("Escape");
  }).toPass({ timeout: 30_000 });

  // Alice reads Spanish, one of the languages whose line was cut; Bob has no name, so the chat calls him "Contacto · …".
  await alice.page.evaluate(() => localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}"), language: "es" })));
  await alice.page.reload();
  await expect(alice.page.locator("html")).toHaveAttribute("lang", /^es/);
  const status = alice.page.getByTestId("connection-options");
  await expect(status).toHaveAttribute("data-status", "Connected", { timeout: 60_000 });

  await bob.page.close();
  await expect(status).toHaveAttribute("data-status", "Away · messages are held", { timeout: 60_000 });
  const box = alice.page.getByPlaceholder("Mensaje…");
  for (const n of [1, 2, 3]) {
    await box.fill(`held ${n}${LONG}`);
    await box.press("Enter");
  }
  const line = alice.page.getByTestId("hold-indicator").locator("p").first();
  await expect(line).toHaveText(/^3 elementos guardados para .+ · [\d,]+ MB de \d+ MB$/, { timeout: 30_000 });
  expect(await line.evaluate((el) => ({ cut: el.scrollWidth - el.clientWidth, inside: el.getBoundingClientRect().right <= document.documentElement.clientWidth })))
    .toEqual({ cut: 0, inside: true });
});

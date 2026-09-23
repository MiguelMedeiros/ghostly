import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { BIG, BIG_SHA256 } from "../../extension/test/atlas.mjs";
import { chat, connect, linkLegacy, say } from "../support/fixtures";
import { expect, test } from "../support/extension";

/** Same protocol, same UI, different hosts: the extension and a plain web page. */
test("the extension and the web app chat, share files and call", async ({ extensionPeer, webPeer }, testInfo) => {
  const [ext, web] = await Promise.all([extensionPeer("extension"), webPeer("web")]);
  await linkLegacy(web, ext);
  await connect(web, ext);
  await say(ext, "boo from the extension");
  await expect(chat(web).getByText("boo from the extension")).toBeVisible();

  const file = testInfo.outputPath("from the web.bin");
  writeFileSync(file, BIG);
  await web.page.getByTestId("file-input").setInputFiles(file);
  const bubble = ext.page.getByTestId("file-bubble").filter({ hasText: "from the web.bin" });
  await expect(bubble.getByTestId("file-save")).toBeVisible();
  const download = ext.page.waitForEvent("download");
  await bubble.getByTestId("file-save").click();
  expect(createHash("sha256").update(readFileSync(await (await download).path())).digest("hex")).toBe(BIG_SHA256);

  await web.page.getByTitle("Video call").click();
  await ext.page.getByTitle("Accept video call").click();
  for (const p of [ext, web]) await expect(p.page.getByText(/^\d{1,2}:\d{2}$/).first()).toBeVisible();
  await web.page.getByTitle("End call").click();
  await expect(ext.page.getByTitle("End call")).toHaveCount(0);
});

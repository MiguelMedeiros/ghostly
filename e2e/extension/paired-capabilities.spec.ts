import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chat, openChat, openWallet } from "../support/fixtures";
import { expect, test } from "../support/extension";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";

test("paired extension and web exchange verified files and local-mint sats", { tag: ["@client:extension", "@client:web", "@feature:extension.interop", "@feature:files.paired.send", "@feature:payments.cashu.send", "@feature:payments.cashu.request", "@feature:payments.chat.review", "@feature:wallet.cashu.mint.add", "@feature:wallet.cashu.mint.manage"] }, async ({ extensionPeer, webPeer }) => {
  test.skip(!process.env.E2E_MINT_URL?.startsWith("http://127.0.0.1:"), "Requires a local fake mint");
  const [ext, web] = await Promise.all([extensionPeer("paired-ext"), webPeer("paired-web")]);
  await pair(web, ext);
  const bytes = Buffer.alloc(256 * 1024 + 7, 19);
  for (const [sender, receiver] of [[web, ext], [ext, web]]) {
    await sender.page.getByTestId("file-input").setInputFiles({ name: "interop.bin", mimeType: "application/octet-stream", buffer: bytes });
    const save = receiver.page.getByTestId("file-bubble").filter({ hasText: "interop.bin" }).last().getByTestId("file-save");
    await expect(save).toBeVisible(); const downloading = receiver.page.waitForEvent("download"); await save.click();
    expect(createHash("sha256").update(readFileSync(await (await downloading).path())).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
  }
  for (const p of [ext, web]) {
    await openWallet(p, "cashu");
    // A mint on this machine holds test sats: it is listed in the Testnet mode only, like web/paired-capabilities.
    await p.page.getByTestId("wallet-mode").getByRole("radio", { name: "Testnet" }).click();
    await p.page.getByTestId("wallet-mint-url").fill(process.env.E2E_MINT_URL!); await p.page.getByTestId("wallet-add-mint").click();
    await expect(p.page.getByTestId("wallet-mint-url")).toHaveValue("");
    await p.page.getByTestId("mint-row").filter({ hasText: "127.0.0.1" }).getByRole("button", { name: "Make primary", exact: true }).click();
    if (p === ext) await openChat(p);
  }
  await web.page.getByTestId("wallet-receive").click(); await web.page.getByTestId("wallet-receive-amount").fill("50"); await web.page.getByTestId("wallet-create-invoice").click();
  await expect(web.page.getByTestId("wallet-paid")).toBeVisible();
  await openChat(web);
  await (await composerRow(web.page, "payment-button")).click(); await web.page.getByTestId("payment-card-cashu").click(); await web.page.getByTestId("payment-amount").fill("12"); await web.page.getByTestId("payment-send").click();
  // Every send is reviewed first: nothing leaves before the approval.
  await web.page.getByTestId("payment-composer").getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  for (const p of [web, ext]) await expect(chat(p).getByTestId("payment-bubble").filter({ hasText: "12" }).getByTestId("payment-state")).toHaveText(/Received/);
  await web.page.keyboard.press("Escape");
  await expect(web.page.getByTestId("payment-composer")).toHaveCount(0);
  // Ecash only: the fake mint pays a request's own Lightning invoice by itself and would race the payer.
  await ext.page.getByTestId("chat-options").click();
  await ext.page.getByTestId("chat-payments-open").click();
  await ext.page.getByTestId("chat-payments").getByTestId("chat-payments-lightning").click();
  await ext.page.getByTestId("chat-payments-save").click();
  await (await composerRow(ext.page, "payment-button")).click(); await ext.page.getByTestId("payment-card-cashu").click(); await ext.page.getByTestId("payment-amount").fill("5"); await ext.page.getByTestId("payment-request").click();
  await web.page.getByTestId("payment-pay").click();
  await chat(web).getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  for (const p of [web, ext]) await expect(chat(p).getByTestId("payment-bubble").filter({ hasText: "equest" }).getByTestId("payment-state")).toHaveText(/Paid/);
});

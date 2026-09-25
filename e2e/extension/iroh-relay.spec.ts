import { endpoints } from "../infra/env.mjs";
import { chat, connect, link, say } from "../support/fixtures";
import { expect, test } from "../support/extension";

// The extension's peer lives in an offscreen document: Iroh's wasm loads there, and its relay WebSocket leaves
// from there, under the manifest's CSP (`'wasm-unsafe-eval'`, no connect-src limit). Chosen from the chat's
// Connection menu, the chat with a web page moves onto Iroh, through the e2e infra's relay.
test.skip(!process.env.GHOSTLY_IROH_RELAY_URL, "Needs the e2e infra's Iroh relay (npm run e2e:infra:use)");

test("the extension runs Iroh in its offscreen document and moves a chat with a web page onto it, relayed", {
  tag: ["@client:extension", "@client:web", "@feature:transport.iroh-web", "@feature:transport.relayed", "@feature:transport.chat-switch"],
}, async ({ extensionPeer, webPeer }) => {
  test.setTimeout(4 * 60_000);
  const relay = endpoints.irohRelay;
  const [ext, web] = await Promise.all([extensionPeer("extension", { irohRelay: relay }), webPeer("web", { irohRelay: relay })]);
  await link(web, ext);
  await connect(web, ext);
  for (const p of [ext, web]) {
    await p.page.getByTestId("connection-options").click();
    await expect(p.page.getByTestId("connection-option-iroh")).toBeEnabled({ timeout: 60_000 });
    await p.page.keyboard.press("Escape");
  }

  await ext.page.getByTestId("chat-options").click();
  await ext.page.getByTestId("chat-connection-open").click();
  await ext.page.getByTestId("transport-menu").getByTestId("transport-option-iroh").click();
  for (const p of [ext, web]) {
    const icon = p.page.getByTestId("connection-options");
    await expect(icon).toHaveAttribute("data-transport", "iroh/1", { timeout: 60_000 });
    await expect(icon).toHaveAttribute("data-relayed", "");
  }
  await say(ext, "from the offscreen document, over Iroh");
  await expect(chat(web).getByText("from the offscreen document, over Iroh")).toBeVisible({ timeout: 60_000 });
  await say(web, "and back to the extension");
  await expect(chat(ext).getByText("and back to the extension")).toBeVisible({ timeout: 60_000 });
});

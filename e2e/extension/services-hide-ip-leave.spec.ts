import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { connect, linkLegacy } from "../support/fixtures";
import { expect, test } from "../support/extension";

/**
 * A contact's shared app does not open in the extension while Hide my IP from contacts is on: its script could send the
 * tab, or a frame, to a server of the contact's, and Chrome connects there before any policy or DevTools refuses the
 * page, which shows that server this device's address. The app says why, and with the setting off it opens as before.
 * The contact's server is a port on this machine that counts who connects, before any TLS.
 */
const APP_PORT = 46075;
const CONTACT_PORT = 46076;

async function listen(server: Server | NetServer, port: number): Promise<void> {
  await new Promise<void>((done, failed) => { server.once("error", failed); server.listen(port, "127.0.0.1", () => done()); });
}

test("a contact's app does not open while Hide my IP from contacts is on, so it never sends this browser to the contact's server", {
  tag: ["@feature:settings.network.relay-only", "@feature:services.open"],
}, async ({ extensionPeer }) => {
  test.setTimeout(8 * 60_000);
  let connections = 0;
  const contact = createNetServer((socket) => { connections++; socket.destroy(); });
  // The app sends whatever holds it to the contact's server once it has loaded.
  const app = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Atlas</title><h1>Atlas</h1><script>
      document.body.dataset.ready = "1";
      setTimeout(() => { location.href = "https://127.0.0.1:${CONTACT_PORT}/away"; }, 1500);
    </script>`);
  });
  await listen(contact, CONTACT_PORT);
  await listen(app, APP_PORT);
  try {
    const [a, b] = await Promise.all([extensionPeer("chrome-a"), extensionPeer("chrome-b")]);
    await linkLegacy(a, b);
    await connect(a, b);

    await a.page.getByTestId("account-services").click();
    await a.page.getByTestId("add-service").click();
    await a.page.getByTestId("service-name").fill("Atlas");
    await a.page.getByTestId("service-target").fill(`localhost:${APP_PORT}`);
    await a.page.getByTestId("service-save").click();
    await a.page.getByTestId("service-item").getByTestId("service-people").click();
    await a.page.getByTestId("service-grant").getByRole("switch").click();

    // As the app asks with Hide my IP from contacts on (`extensionHost.openService`'s `relayOnly`). The setting itself
    // needs a TURN server to reach the contact through, which this suite has none of.
    await b.page.evaluate(() => {
      const page = window as unknown as { relayOnly: boolean; chrome: { runtime: { sendMessage: (message: unknown) => Promise<unknown> } } };
      const { runtime } = page.chrome;
      const send = runtime.sendMessage.bind(runtime);
      page.relayOnly = true;
      runtime.sendMessage = (message) =>
        send((message as { type?: string })?.type === "open-service" ? { ...(message as object), relayOnly: page.relayOnly } : message);
    });
    const open = b.page.getByTestId("open-service").filter({ hasText: "Atlas" });
    await expect(open).toBeVisible({ timeout: 120_000 });
    const pages = b.context.pages().length;
    await open.click();
    const refused = b.page.getByText("A contact's app does not open here while Hide my IP is on.");
    // Until the app says why, or a tab it opened has had the time to load the app and send it away.
    await expect.poll(async () => connections > 0 || (await refused.isVisible()), { timeout: 60_000 }).toBe(true);
    await b.page.waitForTimeout(3_000);
    expect(connections, "the contact's server is never reached").toBe(0);
    expect(b.context.pages(), "no tab opened").toHaveLength(pages);
    await expect(refused).toBeVisible();

    // With it off, the app opens in a tab as before.
    await b.page.evaluate(() => { (window as unknown as { relayOnly: boolean }).relayOnly = false; });
    const viewerPromise = b.context.waitForEvent("page");
    await open.click();
    const viewer = await viewerPromise;
    await viewer.waitForSelector("body[data-ready='1']", { timeout: 150_000 });
  } finally {
    app.close();
    contact.close();
  }
});

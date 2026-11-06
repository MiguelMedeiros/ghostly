import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { withViewerPolicy } from "@ghostly/core";
import { expect, test } from "../support/fixtures";

/**
 * A contact's shared app names a server of its own in its page (`<img src="https://contact.example/p.png">`): with
 * Hide my IP from contacts on, Ghostly's policy keeps the browser from reaching it, so that server never sees this
 * device's address; with it off, as before. The page is served the way the extension serves one (`withViewerPolicy`;
 * Desktop's `SERVICE_CSP_RELAY_ONLY` and the CLI's `OPENED_SERVICE_CSP_RELAY_ONLY` are the same value, pinned by
 * packages/core/test/http.test.ts), and the contact's server is a TLS port on this machine that counts who connects.
 */
const PAGE_PORT = 6320;
const CONTACT_PORT = 6321;

async function listen(server: Server | NetServer, port: number): Promise<void> {
  await new Promise<void>((done, failed) => { server.once("error", failed); server.listen(port, "127.0.0.1", () => done()); });
}

test("a contact's app loads nothing from a server it names while Hide my IP from contacts is on, and does with it off", {
  tag: ["@feature:settings.network.relay-only"],
}, async ({ browser }) => {
  // The contact's server: a connection is all it takes to learn the address, so one is counted before any TLS.
  let connections = 0;
  const contact = createNetServer((socket) => { connections++; socket.destroy(); });
  let relayOnly = false;
  const page = createServer((_request, response) => {
    const headers = withViewerPolicy([["content-type", "text/html; charset=utf-8"]], relayOnly);
    response.writeHead(200, Object.fromEntries(headers));
    response.end(`<!doctype html><title>Atlas</title><h1>Atlas</h1>
      <img src="https://127.0.0.1:${CONTACT_PORT}/p.png">
      <link rel="stylesheet" href="https://127.0.0.1:${CONTACT_PORT}/s.css">
      <script src="https://127.0.0.1:${CONTACT_PORT}/s.js"></script>`);
  });
  await listen(contact, CONTACT_PORT);
  await listen(page, PAGE_PORT);
  const context = await browser.newContext();
  try {
    for (const on of [true, false]) {
      relayOnly = on;
      connections = 0;
      const tab = await context.newPage();
      await tab.goto(`http://127.0.0.1:${PAGE_PORT}/?relayOnly=${on}`, { waitUntil: "load" });
      await expect(tab.locator("h1")).toHaveText("Atlas");
      // What the page asked for has had its time: the TLS port answers at once on this machine.
      await tab.waitForTimeout(1_000);
      if (on) expect(connections, "Hide my IP on: the contact's server is never reached").toBe(0);
      else expect(connections, "Hide my IP off: as before, the page loads from https sites").toBeGreaterThan(0);
      await tab.close();
    }
  } finally {
    await context.close();
    page.close();
    contact.close();
  }
});

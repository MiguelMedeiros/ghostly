import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from "node:net";
import { VIEWER_GUARD_SCRIPT, viewerResponseHeaders, withViewerPolicy } from "@ghostly/core";
import { expect, test } from "../support/fixtures";

/** Listens on a port the system picks and gives it back: copies of these tests run side by side (`--repeat-each`). */
function listen(server: Server | NetServer, host = "127.0.0.1"): Promise<number> {
  return new Promise<number>((done, failed) => {
    server.once("error", failed);
    server.listen(0, host, () => done((server.address() as AddressInfo).port));
  });
}

/**
 * A contact's shared app names a server of its own in its page (`<img src="https://contact.example/p.png">`): with
 * Hide my IP from contacts on, Ghostly's policy keeps the browser from reaching it, so that server never sees this
 * device's address; with it off, as before. The page is served the way the extension serves one (`withViewerPolicy`;
 * Desktop's `SERVICE_CSP_RELAY_ONLY` and the CLI's `OPENED_SERVICE_CSP_RELAY_ONLY` are the same value, pinned by
 * packages/core/test/http.test.ts), and the contact's server is a TLS port on this machine that counts who connects.
 */
test("a contact's app loads nothing from a server it names while Hide my IP from contacts is on, and does with it off", {
  tag: ["@feature:settings.network.relay-only"],
}, async ({ browser }) => {
  // The contact's server: a connection is all it takes to learn the address, so one is counted before any TLS.
  let connections = 0;
  const contact = createNetServer((socket) => { connections++; socket.destroy(); });
  const contactPort = await listen(contact);
  let relayOnly = false;
  const page = createServer((_request, response) => {
    const headers = withViewerPolicy([["content-type", "text/html; charset=utf-8"]], relayOnly);
    response.writeHead(200, Object.fromEntries(headers));
    response.end(`<!doctype html><title>Atlas</title><h1>Atlas</h1>
      <img src="https://127.0.0.1:${contactPort}/p.png">
      <link rel="stylesheet" href="https://127.0.0.1:${contactPort}/s.css">
      <script src="https://127.0.0.1:${contactPort}/s.js"></script>`);
  });
  const pagePort = await listen(page);
  const context = await browser.newContext();
  try {
    for (const on of [true, false]) {
      relayOnly = on;
      connections = 0;
      const tab = await context.newPage();
      await tab.goto(`http://127.0.0.1:${pagePort}/?relayOnly=${on}`, { waitUntil: "load" });
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

/**
 * A contact's app asks Chromium to prefetch and prerender pages of a server it names, with the `Speculation-Rules`
 * header and an inline `<script type="speculationrules">`: no policy covers either, and the fetch shows that server
 * this device's address. Served the way Desktop's window serves one with Hide my IP from contacts on: the contact's
 * headers as a viewer passes them on (`viewerResponseHeaders`, Desktop's `DROPPED_HEADERS` is the same list), the
 * relay-only policy, and the WebRTC guard first in the page (`VIEWER_GUARD_SCRIPT`, Desktop's `SERVICE_GUARD`), in a
 * top-level page as Desktop's (a frame's speculation rules do nothing). Without them, the same page reaches it.
 */
test("a contact's app gets no prefetch or prerender of a server it names while Hide my IP from contacts is on", {
  tag: ["@feature:settings.network.relay-only"],
}, async ({ browser }) => {
  const reached: string[] = [];
  const contact = createServer((request, response) => {
    reached.push(request.url ?? "");
    const rules = request.url === "/rules.json";
    response.writeHead(200, { "content-type": rules ? "application/speculationrules+json" : "text/html", "access-control-allow-origin": "*" });
    response.end(rules ? JSON.stringify({ prefetch: [{ source: "list", urls: [`http://127.0.0.1:${contactPort}/header-prefetch`] }] }) : "x");
  });
  const contactPort = await listen(contact);
  const inline = (tag: string) => JSON.stringify({
    prefetch: [{ source: "list", urls: [`http://127.0.0.1:${contactPort}/${tag}-prefetch`] }],
    prerender: [{ source: "list", urls: [`http://127.0.0.1:${contactPort}/${tag}-prerender`] }],
  });
  let guarded = true;
  const page = createServer((_request, response) => {
    const sent: [string, string][] = [["content-type", "text/html; charset=utf-8"], ["Speculation-Rules", `"http://127.0.0.1:${contactPort}/rules.json"`]];
    const headers = guarded ? withViewerPolicy(viewerResponseHeaders(sent), true) : sent;
    response.writeHead(200, Object.fromEntries(headers));
    // In the HTML, put in by a script, and put in empty and filled after.
    response.end(`<!doctype html><title>Atlas</title><h1>Atlas</h1>
      <script type="speculationrules">${inline("parsed")}</script>
      <script>
        const made = document.createElement("script");
        made.type = "speculationrules";
        made.textContent = ${JSON.stringify(inline("made"))};
        document.head.appendChild(made);
        const late = document.createElement("script");
        document.body.appendChild(late);
        late.setAttribute("type", "SpeculationRules");
        late.appendChild(document.createTextNode(${JSON.stringify(inline("late"))}));
      </script>`);
  });
  const pagePort = await listen(page, "localhost");
  try {
    for (const on of [false, true]) {
      guarded = on;
      reached.length = 0;
      // A context of its own each time: a prefetch made once is kept for the next page.
      const context = await browser.newContext();
      try {
        const tab = await context.newPage();
        if (on) await tab.addInitScript(VIEWER_GUARD_SCRIPT);
        await tab.goto(`http://localhost:${pagePort}/`, { waitUntil: "load" });
        await expect(tab.locator("h1")).toHaveText("Atlas");
        if (on) {
          await tab.waitForTimeout(2_000);
          expect(reached, "Hide my IP on: the contact's server is never reached").toEqual([]);
        } else {
          // The browser does speculate here: the same page with nothing in its way reaches the server each way.
          await expect.poll(() => [...reached].sort()).toEqual(expect.arrayContaining(["/rules.json", "/parsed-prefetch", "/made-prefetch", "/late-prefetch"]));
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    page.close();
    contact.close();
  }
});

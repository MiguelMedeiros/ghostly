import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { guardViewerAnswer, utf8Encode, viewerServicePolicy, VIEWER_GUARD_HASH, VIEWER_GUARD_SCRIPT, type HeaderList } from "@ghostly/core";
import { expect, test } from "../support/fixtures";

/**
 * A contact's shared app makes a WebRTC connection of its own, with a STUN server it names: no policy covers ICE, so
 * that server would see this device's address. With Hide my IP from contacts on, the web app serves each of the app's
 * pages with Ghostly's guard first in it (`guardViewerAnswer`, as apps/web/src/svc/opener.ts does) inside its bridge
 * page, which runs the guard too: no packet reaches the server from the page, the frames it makes, their `srcdoc`
 * pages, the window that frames it or a page sent as two types. With it off, each of those reaches it, as before.
 * The STUN server is a UDP port on this machine that counts what reaches it.
 *
 * Not here, as a script in the page cannot do it (`VIEWER_GUARD_SCRIPT`): a frame's window read by its index while the
 * frame's page is on its way, and a `srcdoc` frame in a shadow tree written in the page's own HTML.
 */
const PAGE_PORT = 6322;
const STUN_PORT = 6323;

/** What the contact's pages use (`/try.js`): a connection with the constructor a page found, if it found one. */
const TRY = `async function attempt(find) {
  let made = null;
  try { made = find(); } catch (e) {}
  if (typeof made !== "function") return;
  const connection = new made({ iceServers: [{ urls: "stun:127.0.0.1:${STUN_PORT}" }] });
  connection.createDataChannel("x");
  await connection.setLocalDescription();
}
function frame(src, into) {
  const made = document.createElement("iframe");
  if (src) made.src = src;
  (into || document.body).append(made);
  return made;
}`;

/** The contact's pages by path: each tries one way to a WebRTC constructor. */
const CASES: Record<string, string> = {
  "the page itself": `attempt(() => window.RTCPeerConnection || window.webkitRTCPeerConnection);`,
  "an empty frame, used at once": `const made = frame(); attempt(() => made.contentWindow.RTCPeerConnection);`,
  "a frame while its page loads": `const made = frame("/slow"); attempt(() => made.contentWindow.RTCPeerConnection);`,
  "the document of a frame while its page loads": `const made = frame("/slow"); attempt(() => made.contentDocument.defaultView.RTCPeerConnection);`,
  "an empty frame in a shadow tree": `const made = frame("", document.body.appendChild(document.createElement("div")).attachShadow({ mode: "closed" })); attempt(() => made.contentWindow.RTCPeerConnection);`,
  "an empty frame by its index": `frame(); attempt(() => window[0].RTCPeerConnection);`,
  "a frame of its own origin": `frame("/inner");`,
  "a srcdoc frame": `frame().srcdoc = document.querySelector("textarea").value;`,
  "a srcdoc frame in a shadow tree": `frame("", document.body.appendChild(document.createElement("div")).attachShadow({ mode: "open" })).srcdoc = document.querySelector("textarea").value;`,
  "the window that frames it": `attempt(() => parent.RTCPeerConnection);`,
  "a page sent as two types": `frame("/two-types");`,
};
const NAMES = Object.keys(CASES);

/** A page of the contact's. `/go.js` tries with the constructor of the window it runs in; the hidden text is a `srcdoc`. */
const html = (body: string) => `<!doctype html><title>Atlas</title><body><textarea hidden><script src="/go.js"></script></textarea>${body}`;

test("a contact's app makes no WebRTC connection of its own in the web app while Hide my IP from contacts is on, and does with it off", {
  tag: ["@feature:settings.network.relay-only", "@feature:services.web-open"],
}, async ({ browser }) => {
  let packets = 0;
  const stun = createSocket("udp4");
  stun.on("message", () => { packets++; });
  await new Promise<void>((done) => stun.bind(STUN_PORT, "127.0.0.1", done));
  let relayOnly = false;
  // The contact's answer by path, before Ghostly touches it.
  const contact = (path: string): { headers: HeaderList; body: string; wait?: number } => {
    const page: HeaderList = [["content-type", "text/html; charset=utf-8"]];
    if (path.startsWith("/case/")) return { headers: page, body: html(`<script src="/try.js"></script><script>${CASES[NAMES[Number(path.slice(6))]]}</script>`) };
    if (path === "/try.js") return { headers: [["content-type", "text/javascript"]], body: TRY };
    if (path === "/go.js") return { headers: [["content-type", "text/javascript"]], body: `${TRY}\nattempt(() => self.RTCPeerConnection || self.webkitRTCPeerConnection);` };
    if (path === "/inner") return { headers: page, body: html(`<script src="/go.js"></script>`) };
    if (path === "/slow") return { headers: page, body: html(""), wait: 700 };
    // HTML by the first type and an SVG by the last, which is the one a browser renders.
    if (path === "/two-types") return { headers: [["content-type", "text/html"], ["content-type", "image/svg+xml"]], body: `<svg xmlns="http://www.w3.org/2000/svg"><script href="/go.js"/></svg>` };
    return { headers: [["content-type", "text/plain"]], body: "" };
  };
  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? "/";
      if (path.startsWith("/bridge/")) {
        // Ghostly's own page on the app's origin (apps/web/src/svc/bridge.ts): it runs the guard, then frames the app.
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `default-src 'none'; script-src 'self' ${VIEWER_GUARD_HASH}; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'`,
        });
        response.end(`<!doctype html><title>Ghostly</title>${relayOnly ? `<script>${VIEWER_GUARD_SCRIPT}</script>` : ""}<iframe id="app" sandbox="allow-scripts allow-same-origin allow-forms" allow="" src="/case/${Number(path.slice(8))}"></iframe>`);
        return;
      }
      const answer = contact(path);
      if (answer.wait) await new Promise((done) => setTimeout(done, answer.wait));
      let headers = answer.headers;
      let body: AsyncIterable<Uint8Array> = (async function* () { yield utf8Encode(answer.body); })();
      // As `serve` in apps/web/src/svc/opener.ts: the guard with Hide my IP on, then Ghostly's policy after the contact's.
      const destination = request.headers["sec-fetch-dest"];
      if (relayOnly) ({ headers, body } = await guardViewerAnswer(headers, body, typeof destination === "string" ? destination : null));
      headers = [...headers, ["content-security-policy", viewerServicePolicy(relayOnly)]];
      for (const name of new Set(headers.map(([header]) => header))) response.setHeader(name, headers.filter(([header]) => header === name).map(([, value]) => value));
      response.writeHead(200);
      for await (const chunk of body) response.write(chunk);
      response.end();
    })();
  });
  await new Promise<void>((done, failed) => { server.once("error", failed); server.listen(PAGE_PORT, "127.0.0.1", () => done()); });
  const context = await browser.newContext();
  try {
    for (const [index, name] of NAMES.entries()) {
      for (const on of [false, true]) {
        relayOnly = on;
        packets = 0;
        const tab = await context.newPage();
        await tab.goto(`http://127.0.0.1:${PAGE_PORT}/bridge/${index}`, { waitUntil: "load" });
        if (on) {
          // The same page reached the server within this time with the setting off, a moment ago.
          await tab.waitForTimeout(2_500);
          expect(packets, `Hide my IP on, ${name}: the contact's STUN server is never reached`).toBe(0);
        } else {
          await expect.poll(() => packets, { message: `Hide my IP off, ${name}: as before, the connection is made`, timeout: 15_000 }).toBeGreaterThan(0);
        }
        await tab.close();
      }
    }
  } finally {
    await context.close();
    server.close();
    stun.close();
  }
});

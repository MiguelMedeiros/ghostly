import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import type { AddressInfo } from "node:net";
import { expect, test } from "../support/extension";
import { pair } from "../support/paired";

/**
 * A contact's shared app makes WebRTC connections of its own, with a STUN server it names: no policy covers ICE, so that
 * server would see this device's address. With Hide my IP from contacts on, the viewer tab runs Ghostly's guard first
 * in each of its documents (`VIEWER_GUARD_SCRIPT`): no packet reaches the server, from the page, an empty frame, a
 * `srcdoc` frame or a frame of its own origin; with it off, as before. The STUN server is a UDP port on this machine
 * that counts what reaches it. The tab is opened as the app opens it with the setting on (`relayOnly` in its message
 * to the worker): turning the setting on here would need a TURN server for the chat itself.
 */
const STUN_PORT = 6573;
const ICE = JSON.stringify({ iceServers: [{ urls: `stun:127.0.0.1:${STUN_PORT}` }] });
const PAGE = `<!doctype html><title>Probe</title><pre id="out">{}</pre><script nonce="a">
const tries = {};
const show = () => { document.getElementById("out").textContent = JSON.stringify(tries); };
async function leak(name, W) { try { const pc = new W.RTCPeerConnection(${ICE}); pc.createDataChannel("x"); await pc.setLocalDescription(); tries[name] = "made"; } catch (e) { tries[name] = "refused"; } show(); }
addEventListener("message", (e) => { if (e.data && e.data.probe) { tries[e.data.probe] = e.data.said; show(); } });
leak("top", window);
const blank = document.createElement("iframe"); document.body.append(blank); leak("blankFrame", blank.contentWindow);
const doc = document.createElement("iframe");
doc.srcdoc = '<script nonce="a">(async () => { try { const pc = new RTCPeerConnection(${ICE}); pc.createDataChannel("x"); await pc.setLocalDescription(); parent.postMessage({ probe: "srcdoc", said: "made" }, "*"); } catch (e) { parent.postMessage({ probe: "srcdoc", said: "refused" }, "*"); } })()<\\/script>';
document.body.append(doc);
const own = document.createElement("iframe"); own.src = "/child"; document.body.append(own);
</script>`;
const CHILD = `<!doctype html><script nonce="a">(async () => { try { const pc = new RTCPeerConnection(${ICE}); pc.createDataChannel("x"); await pc.setLocalDescription(); parent.postMessage({ probe: "ownFrame", said: "made" }, "*"); } catch (e) { parent.postMessage({ probe: "ownFrame", said: "refused" }, "*"); } })()</script>`;

test("a contact's app makes no WebRTC connection of its own while Hide my IP from contacts is on, and does with it off", {
  tag: ["@feature:settings.network.relay-only", "@feature:services.open"],
}, async ({ extensionPeer }) => {
  test.setTimeout(8 * 60_000);
  let packets = 0;
  const stun = createSocket("udp4");
  stun.on("message", () => { packets++; });
  await new Promise<void>((done) => stun.bind(STUN_PORT, "127.0.0.1", done));
  const app = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "script-src 'nonce-a'" });
    response.end(request.url === "/child" ? CHILD : PAGE);
  });
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  try {
    const [a, b] = await Promise.all([extensionPeer("hide-ip-rtc-a"), extensionPeer("hide-ip-rtc-b")]);
    await pair(a, b);
    await a.page.getByTestId("account-services").click();
    await a.page.getByTestId("add-service").click();
    await a.page.getByTestId("service-name").fill("Probe");
    await a.page.getByTestId("service-target").fill(`localhost:${(app.address() as AddressInfo).port}`);
    await a.page.getByTestId("service-save").click();
    const item = a.page.getByTestId("service-item").filter({ hasText: "Probe" });
    await item.getByTestId("service-people").click();
    const grant = item.getByTestId("service-grant").getByRole("switch");
    await grant.click();
    await expect(grant).toHaveAttribute("aria-checked", "true");

    const open = b.page.getByTestId("open-service").filter({ hasText: "Probe" });
    await expect(open).toBeVisible({ timeout: 120_000 });
    for (const relayOnly of [false, true]) {
      // The page asks the worker for the tab as it does with the setting on (extensionHost.openService).
      await b.page.evaluate((on) => {
        const runtime = (globalThis as unknown as { chrome: { runtime: { sendMessage: (message: unknown) => Promise<unknown> } } }).chrome.runtime;
        const send = (runtime as { __send?: typeof runtime.sendMessage }).__send ??= runtime.sendMessage.bind(runtime);
        runtime.sendMessage = (message) => send((message as { type?: string })?.type === "open-service" ? { ...(message as object), relayOnly: on } : message);
      }, relayOnly);
      packets = 0;
      const opened = b.context.waitForEvent("page");
      await open.click();
      const viewer = await opened;
      await expect.poll(async () => Object.keys(JSON.parse((await viewer.locator("#out").textContent().catch(() => null)) || "{}")).length, { timeout: 150_000 }).toBe(4);
      // What the page started has had its time: the UDP port is on this machine.
      await viewer.waitForTimeout(3_000);
      const tries = JSON.parse((await viewer.locator("#out").textContent())!);
      if (relayOnly) {
        expect(tries, "Hide my IP on: every realm refused").toEqual({ top: "refused", blankFrame: "refused", srcdoc: "refused", ownFrame: "refused" });
        expect(packets, "Hide my IP on: the contact's STUN server is never reached").toBe(0);
      } else {
        expect(tries, "Hide my IP off: as before").toEqual({ top: "made", blankFrame: "made", srcdoc: "made", ownFrame: "made" });
        expect(packets, "Hide my IP off: the probe's packets reach it").toBeGreaterThan(0);
      }
      await viewer.close();
    }
  } finally {
    app.close();
    stun.close();
  }
});

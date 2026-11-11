import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pasteInvite } from "../support/clipboard";
import { expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * A contact's shared web app on the web (WISP 701) writes the clipboard only in the person's own tap in it: a copy
 * button copies on its tap, and nothing else does, not on load, not from a timer seconds after a tap on something else
 * (Chromium lets `execCommand("copy")` write for as long as a tap's activation lasts, 5 s). What the person copied in
 * Ghostly stays on the clipboard. Real time and real input only while the timers run: Playwright's evaluations and
 * checks in the frame act as user gestures in Chromium.
 */
test.describe.configure({ timeout: 5 * 60_000 });

const PAGE = `<!doctype html><title>Pay</title><body style="margin:0">
<textarea id="t" style="position:fixed;left:-9999px"></textarea>
<div id="pad" style="height:50vh;background:#eee">Tap anywhere</div>
<button id="copy">Copy my address</button>
<pre id="log">{}</pre>
<script>
  const log = {}, t = document.getElementById("t");
  const out = () => { document.getElementById("log").textContent = JSON.stringify(log); };
  const write = (text, realm = window) => { t.value = text; t.select(); try { return realm.Document.prototype.execCommand.call(document, "copy"); } catch (e) { return e.name; } };
  log.load = write("bc1q-CONTACT-load");
  // Another realm's execCommand on this document: an empty frame of its own (read by its index) and the bridge's.
  document.body.appendChild(document.createElement("iframe"));
  const realms = { frame: window[0], parent: window.parent };
  let taps = 0;
  document.getElementById("pad").addEventListener("pointerdown", () => {
    if (taps++) return;
    for (const ms of [500, 2000, 4500]) setTimeout(() => { log["timer" + ms] = write("bc1q-CONTACT-timer" + ms); out(); }, ms);
    for (const [name, realm] of Object.entries(realms)) setTimeout(() => { log[name] = write("bc1q-CONTACT-" + name, realm); out(); }, 1000);
  });
  document.getElementById("copy").addEventListener("click", () => { log.button = write("bc1q-CONTACT-button"); out(); });
  out();
</script>`;

test("a contact's app writes the clipboard only in the person's tap on its copy button, never from a timer after a tap", {
  tag: ["@feature:services.web-open"],
}, async ({ peer, relay }, info) => {
  const url = await relay.listen();
  const app = createServer((request, response) => {
    if (request.url === "/sandboxed") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "sandbox allow-scripts" });
      response.end("<!doctype html><p>Opaque</p>");
      return;
    }
    if (request.url !== "/") { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Pay bot");
    const person = await peer("person", { serviceWorkers: "allow", beforeOpen: async (context) => {
      // Read only, for the checks: a granted clipboard-write would let every write through, a tap or none.
      await context.grantPermissions(["clipboard-read"]);
      await context.addInitScript(() => {
        try { if (location.hostname === "localhost") localStorage.setItem("ghostly-test-services", "on"); } catch { /* opaque origin */ }
      });
    } });
    const invite = await bot.run("invite", "create", "--label", "person");
    await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(person.page, invite.invite as string);
    await expect(person.page.getByPlaceholder("Message…")).toBeEnabled();
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    await bot.run("service", "add", "Pay", `http://127.0.0.1:${(app.address() as AddressInfo).port}`);
    await bot.run("service", "share", "pay", invite.chat as string);

    const open = person.page.getByTestId("open-service").filter({ hasText: "Pay" });
    await expect(open).toBeVisible({ timeout: 120_000 });
    await open.click();
    const frame = person.page.frameLocator("[data-testid=service-view-frame]").frameLocator("iframe");
    await expect(frame.locator("#log")).toContainText("load", { timeout: 60_000 });
    const log = async () => JSON.parse((await frame.locator("#log").textContent())!) as Record<string, unknown>;

    // The person's own copy, in Ghostly's page (the app's frame is not activated by it).
    // The real clipboard: pasteInvite left a stub of its own on the page's navigator.
    await person.page.evaluate(() => Reflect.deleteProperty(navigator, "clipboard"));
    const clipboard = () => person.page.evaluate(() => navigator.clipboard.readText());
    await person.page.evaluate(() => navigator.clipboard.writeText("bc1q-PERSON-OWN"));
    expect(await clipboard()).toBe("bc1q-PERSON-OWN");

    // One tap on something that is not a copy button, then nothing but waiting while the app's timers write.
    const pad = (await person.page.getByTestId("service-view-frame").boundingBox())!;
    await person.page.mouse.click(pad.x + pad.width / 2, pad.y + 40);
    await person.page.waitForTimeout(6_000);
    const seen = await log();
    info.annotations.push({ type: "clipboard writes", description: JSON.stringify(seen) });
    expect(Object.keys(seen)).toEqual(expect.arrayContaining(["timer500", "timer2000", "timer4500", "frame", "parent"]));
    expect(seen).toMatchObject({ load: false, timer500: false, timer2000: false, timer4500: false, frame: false, parent: false });
    expect(await clipboard()).toBe("bc1q-PERSON-OWN");

    // A copy button still copies on its own tap.
    await frame.locator("#copy").click();
    await expect.poll(async () => (await log()).button).toBe(true);
    expect(await clipboard()).toBe("bc1q-CONTACT-button");

    // A page the guard's run cannot be seen in (its own `sandbox` policy makes it opaque to the bridge) is not shown.
    await frame.locator("body").evaluate(() => { location.href = "/sandboxed"; });
    await expect(person.page.frameLocator("[data-testid=service-view-frame]").locator("body")).toHaveText("This page of the app cannot be shown here.", { timeout: 30_000 });
  } catch (error) {
    await bot.attachLogs(info);
    throw error;
  } finally {
    await bot.stop();
    app.close();
  }
});

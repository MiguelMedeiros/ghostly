import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pasteInvite } from "../support/clipboard";
import { expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * A contact's shared web app on the web (WISP 701) writes the clipboard only in the person's own tap in it: a copy
 * button copies on its tap, and so do a form's submit, a checkbox's change, a double click and the app's own context
 * menu; nothing else does, not on load, not from a timer seconds after a tap on something else (Chromium lets
 * `execCommand("copy")` write for as long as a tap's activation lasts, 5 s), and not from a submit or a change the
 * app's script fires itself (`requestSubmit()`, `click()`) outside a tap. What the person copied in Ghostly stays on
 * the clipboard. Real time and real input only while the timers run: Playwright's evaluations and
 * checks in the frame act as user gestures in Chromium.
 */
test.describe.configure({ timeout: 5 * 60_000 });

const PAGE = `<!doctype html><title>Pay</title><body style="margin:0">
<textarea id="t" style="position:fixed;left:-9999px"></textarea>
<div id="pad" style="height:50vh;background:#eee">Tap anywhere</div>
<button id="copy">Copy my address</button>
<form id="form"><input id="field" value="bc1q"><button id="send">Send</button></form>
<label><input type="checkbox" id="box"> Keep it</label>
<div id="twice">Double click to copy</div>
<div id="menu">Right click to copy</div>
<button id="slow">Copy slowly</button>
<form id="scripted"><input></form>
<input type="checkbox" id="flip">
<pre id="log">{}</pre>
<script>
  const log = {}, t = document.getElementById("t");
  const out = () => { document.getElementById("log").textContent = JSON.stringify(log); };
  const write = (text, realm = window) => { t.value = text; t.select(); try { return realm.Document.prototype.execCommand.call(document, "copy"); } catch (e) { return e.name; } };
  log.load = write("bc1q-CONTACT-load");
  // What the person's own tap sets off copies; the same events fired by the app's script do not.
  let submits = 0, pending = "", flipping = "";
  const on = (id, type, handler) => document.getElementById(id).addEventListener(type, handler);
  on("form", "submit", (event) => { event.preventDefault(); const name = "submit" + ++submits; log[name] = write("bc1q-CONTACT-" + name); out(); });
  on("box", "change", () => { log.box = write("bc1q-CONTACT-box"); out(); });
  on("twice", "dblclick", () => { log.dblclick = write("bc1q-CONTACT-dblclick"); out(); });
  on("menu", "contextmenu", (event) => { event.preventDefault(); log.contextmenu = write("bc1q-CONTACT-contextmenu"); out(); });
  on("scripted", "submit", (event) => { event.preventDefault(); log[pending] = write("bc1q-CONTACT-" + pending); out(); });
  on("flip", "change", () => { log[flipping] = write("bc1q-CONTACT-" + flipping); out(); });
  const submitAs = (name) => { pending = name; document.getElementById("scripted").requestSubmit(); };
  const flipAs = (name) => { flipping = name; document.getElementById("flip").click(); };
  submitAs("submitLoad");
  flipAs("changeLoad");
  // Another realm's execCommand on this document: an empty frame of its own (read by its index) and the bridge's.
  document.body.appendChild(document.createElement("iframe"));
  const realms = { frame: window[0], parent: window.parent };
  let taps = 0;
  document.getElementById("pad").addEventListener("pointerdown", () => {
    if (taps++) return;
    for (const ms of [500, 2000, 4500]) setTimeout(() => { log["timer" + ms] = write("bc1q-CONTACT-timer" + ms); out(); }, ms);
    for (const [name, realm] of Object.entries(realms)) setTimeout(() => { log[name] = write("bc1q-CONTACT-" + name, realm); out(); }, 1000);
    setTimeout(() => { submitAs("submitTimer"); flipAs("changeTimer"); }, 1500);
    // The tightest ones: the next task, and the next frame (asked for in the tap, after the guard's own).
    setTimeout(() => submitAs("submitTimer0"), 0);
    requestAnimationFrame(() => flipAs("changeFrame"));
    new Promise((done) => setTimeout(done, 50)).then(() => submitAs("submitPromise"));
    const channel = new MessageChannel();
    channel.port1.onmessage = () => flipAs("changeMessage");
    channel.port2.postMessage(0);
  });
  document.getElementById("copy").addEventListener("click", () => { log.button = write("bc1q-CONTACT-button"); out(); });
  // A tap kept being dispatched for seconds: the app spins in its own click listener, then copies.
  on("slow", "click", () => { const end = performance.now() + 3000; while (performance.now() < end); log.slow = write("bc1q-CONTACT-slow"); out(); });
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
    const late = ["submitLoad", "changeLoad", "submitTimer0", "changeFrame", "submitTimer", "changeTimer", "submitPromise", "changeMessage"];
    expect(Object.keys(seen)).toEqual(expect.arrayContaining(["timer500", "timer2000", "timer4500", "frame", "parent", ...late]));
    expect(seen).toMatchObject({ load: false, timer500: false, timer2000: false, timer4500: false, frame: false, parent: false });
    expect(seen).toMatchObject(Object.fromEntries(late.map((name) => [name, false])));
    expect(await clipboard()).toBe("bc1q-PERSON-OWN");

    // A copy button still copies on its own tap.
    await frame.locator("#copy").click();
    await expect.poll(async () => (await log()).button).toBe(true);
    expect(await clipboard()).toBe("bc1q-CONTACT-button");

    // What the person's own tap sets off copies too: a form's submit (its button, and Enter in its field), a
    // checkbox's change, a double click and the app's own context menu.
    const copies: [string, () => Promise<unknown>][] = [
      ["submit1", () => frame.locator("#send").click()],
      ["submit2", () => frame.locator("#field").press("Enter")],
      ["box", () => frame.locator("#box").click()],
      ["dblclick", () => frame.locator("#twice").dblclick()],
      ["contextmenu", () => frame.locator("#menu").click({ button: "right" })],
    ];
    for (const [name, act] of copies) {
      await act();
      await expect.poll(async () => (await log())[name], { message: name }).toBe(true);
      expect(await clipboard()).toBe(`bc1q-CONTACT-${name}`);
    }

    // A copy seconds after the tap, though in that tap's own listener, does not count.
    await person.page.evaluate(() => navigator.clipboard.writeText("bc1q-PERSON-OWN"));
    await frame.locator("#slow").click();
    await expect.poll(async () => (await log()).slow, { timeout: 15_000 }).toBe(false);
    expect(await clipboard()).toBe("bc1q-PERSON-OWN");

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

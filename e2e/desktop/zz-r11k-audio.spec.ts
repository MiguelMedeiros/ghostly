import { test } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { desktopHome } from "../support/desktop";
import { LocalRelay } from "../support/relay";
import { desktopNetwork } from "../matrix/desktop";
import { desktopPerson } from "../matrix/people";

// PROBE r11k (not for merge): what holds a WebKitGTK page in Web Audio and HTML audio, and what each costs idle.

/** CPU ticks (utime+stime) of every WebKitWebProcess on this machine. */
function webTicks(): number {
  let total = 0;
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      if (!readFileSync(`/proc/${pid}/comm`, "utf8").startsWith("WebKitWebProces")) continue;
      const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
      total += Number(f[11]) + Number(f[12]);
    } catch { /* gone */ }
  }
  return total;
}
async function idleCpu(label: string): Promise<void> {
  const a = webTicks();
  await new Promise((r) => setTimeout(r, 5000));
  const b = webTicks();
  test.info().annotations.push({ type: "cpu", description: `${label}: ${b - a} ticks in 5 s` });
}

const STEP = `
  const done = arguments[arguments.length - 1];
  const step = arguments[0];
  const out = [];
  let last = Date.now(), longest = 0;
  const watch = setInterval(() => { const now = Date.now(); longest = Math.max(longest, now - last); last = now; }, 50);
  const T = async (label, fn) => { const t = Date.now(); let v; try { v = fn(); } catch (e) { out.push(label + " threw " + e); return; } const sync = Date.now() - t; try { await v; } catch (e) { out.push(label + " rejected " + e); } out.push(label + " sync=" + sync + " total=" + (Date.now() - t)); return v; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const mp3 = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.endsWith(".mp3"));
  const tone = (ctx) => { const o = ctx.createOscillator(), g = ctx.createGain(); g.gain.value = 0.05; o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.1); };
  (async () => {
    const w = window.__r11k ??= {};
    if (step === "suspend-resume") {
      w.ctx = new AudioContext();
      await T("resume1", () => w.ctx.resume()); tone(w.ctx); await wait(500);
      await T("suspend", () => w.ctx.suspend()); await wait(1000);
      await T("resume2", () => w.ctx.resume()); tone(w.ctx); await wait(500);
    } else if (step === "suspend-resume-again") {
      await T("suspend2", () => w.ctx.suspend()); await wait(1000);
      await T("resume3", () => w.ctx.resume()); tone(w.ctx); await wait(500);
    } else if (step === "running-idle") {
      // nothing: the context of the step before stays running
    } else if (step === "suspended-idle") {
      await T("suspend", () => w.ctx.suspend());
    } else if (step === "close") {
      await T("close", () => w.ctx.close());
    } else if (step === "new-context") {
      for (let i = 0; i < 3; i++) {
        const c = w.ctx2 = await T("new" + i, () => new AudioContext());
        await T("resume-new" + i, () => c.resume()); tone(c); await wait(400);
        await T("close-new" + i, () => c.close()); await wait(800);
      }
    } else if (step === "element") {
      out.push("mp3 " + (mp3 ? "found" : "none"));
      for (let i = 0; i < 3; i++) {
        const a = new Audio(mp3); a.volume = 0.2;
        await T("play" + i, () => a.play());
        await new Promise((r) => { a.onended = r; setTimeout(r, 3000); });
        out.push("ended" + i);
        w.kept = a;
        await wait(800);
      }
    } else if (step === "element-same") {
      const a = w.kept;
      for (let i = 0; i < 2; i++) { a.currentTime = 0; await T("replay" + i, () => a.play()); await new Promise((r) => { a.onended = r; setTimeout(r, 3000); }); await wait(800); }
    } else if (step === "element-drop") {
      w.kept = null;
    }
    clearInterval(watch);
    out.push("longest-gap " + longest);
    done(out.join("; "));
  })();
`;

test("r11k audio probe", async () => {
  test.setTimeout(5 * 60_000);
  const relay = new LocalRelay();
  const network = await desktopNetwork(relay);
  const home = desktopHome("ana");
  const p = await desktopPerson("ana", { home: home.dir, env: network.env });
  try {
    // A real key press (WebDriver), so the page may play sound: an input of the probe's own.
    await p.app.execute(`const i = document.createElement("input"); i.id = "r11k"; document.body.append(i);`);
    await p.app.type("#r11k", "x");
    await new Promise((r) => setTimeout(r, 7000)); // the app's own context resumed by the key, then let go of
    await idleCpu("baseline (app context suspended)");
    for (const step of ["suspend-resume", "suspend-resume-again", "running-idle", "suspended-idle", "close", "new-context", "element", "element-same", "element-drop"]) {
      const res = await p.app.executeAsync<string>(STEP, step);
      test.info().annotations.push({ type: step, description: res });
      await idleCpu(`after ${step}`);
    }
  } finally {
    await p.stop();
    home.remove();
    await network.close();
    relay.close();
  }
});

import type { Page } from "@playwright/test";
import type { Peer } from "../support/fixtures";
import { expect, pairWithWeb, PKG, test, type AndroidApp } from "./support/android";

/**
 * A call keeps going with the app out of sight: in the background (Home) or with the screen off. Android silences the
 * microphone of an app out of sight that runs no foreground service of type microphone (6-10 s after it leaves), and
 * the backgrounded WebView lost the call's connection: the contact stopped hearing the phone, and the call ended by
 * itself about 45 s later. The app holds a foreground service of type microphone (camera too, while it sends the
 * camera's picture) with an ongoing "Call with …" notification while a call is on (CallService.kt). The web peer stays
 * in front and counts, every STEP_MS, the audio packets that reach it from the phone.
 */

/** How long the app stays away (E2E_CALL_AWAY_MS for a longer proof), read every STEP_MS. */
const AWAY_MS = Number(process.env.E2E_CALL_AWAY_MS) || 60_000;
const STEP_MS = 5_000;
/** Android silences the microphone 6-10 s after the app leaves, and the connection went at 15 s: what came before says nothing. */
const SILENCED_AFTER_MS = 15_000;
const clock = /^\d{1,2}:\d{2}$/;

/** Every RTCPeerConnection the web page makes from now on. */
async function recordConnections(page: Page): Promise<void> {
  await page.evaluate(() => {
    const own = window.RTCPeerConnection;
    const all: RTCPeerConnection[] = [];
    (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = all;
    window.RTCPeerConnection = class extends own {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args);
        all.push(this);
      }
    } as typeof RTCPeerConnection;
  });
}

/** Audio packets received so far on the call's connections, and the newest connection's state. */
async function audioIn(page: Page): Promise<{ packets: number; state: string }> {
  return page.evaluate(async () => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs ?? [];
    let packets = 0;
    for (const pc of pcs) {
      (await pc.getStats()).forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "audio") packets += s.packetsReceived ?? 0;
      });
    }
    return { packets, state: pcs.at(-1)?.connectionState ?? "none" };
  });
}

/** The foreground-service type bits (ServiceInfo) the probe names. */
const TYPES: [number, string][] = [[0x40, "camera"], [0x80, "microphone"]];

/**
 * The app's call service as Android has it: running, and in the foreground with which types. ServiceRecord's dump
 * gives them as a hex mask (`isForeground=true foregroundId=3 types=00000080`); another format comes back raw.
 */
function callService(app: AndroidApp): string {
  const dump = app.adb.tryRun("shell", "dumpsys", "activity", "services", PKG).out;
  const block = dump.split(/\n {2}\* ServiceRecord/).find((part) => part.includes(".CallService"));
  if (!block) return "none";
  const line = /isForeground=true.*/.exec(block)?.[0];
  if (!line) return "started";
  const mask = /\btypes=(?:0x)?([0-9a-f]+)/i.exec(line);
  if (!mask) return `foreground ? (${line})`;
  const bits = parseInt(mask[1], 16);
  return `foreground ${TYPES.filter(([bit]) => bits & bit).map(([, name]) => name).join("|") || mask[1]}`;
}

/**
 * Whether AudioService has the app's recording silenced now (what Android does to a microphone out of sight): its
 * latest "rec start/update" event for the app says `silenced`, not `not silenced` (the log keeps every past event).
 */
function silenced(app: AndroidApp): boolean {
  const events = app.adb.tryRun("shell", "dumpsys", "audio").out.split("\n").filter((line) => / rec \w+ .*pack:tools\.ghostly\.app/.test(line));
  return /(?<!not) silenced pack:/.test(events.at(-1) ?? "");
}

/** The web peer calls the app, the app answers; then the app is away for AWAY_MS, and back. */
async function callAndAway(app: AndroidApp, web: Peer, away: () => void, back: () => void, label: string) {
  await recordConnections(web.page);
  app.adb.run("shell", "pm", "grant", PKG, "android.permission.RECORD_AUDIO");
  await web.page.getByTestId("call-audio").click();
  await app.page.getByTitle("Accept audio call").click({ timeout: 60_000 });
  for (const page of [web.page, app.page]) await expect(page.getByText(clock).first()).toBeVisible({ timeout: 60_000 });
  // Soft: without it, the packets below still say what the app away does to the call.
  await expect.soft.poll(() => callService(app), { message: "the call service runs, of type microphone" }).toMatch(/^foreground .*microphone/);

  // In front: packets per step.
  let last = (await audioIn(web.page)).packets;
  const front: number[] = [];
  for (let i = 0; i < 2; i++) {
    await new Promise((done) => setTimeout(done, STEP_MS));
    const now = (await audioIn(web.page)).packets;
    front.push(now - last);
    last = now;
  }

  away();
  const seen: string[] = [];
  const late: number[] = [];
  for (let at = STEP_MS; at <= AWAY_MS; at += STEP_MS) {
    await new Promise((done) => setTimeout(done, STEP_MS));
    const now = await audioIn(web.page);
    const on = (await web.page.getByTitle("End call").count()) > 0;
    if (at > SILENCED_AFTER_MS) late.push(on ? now.packets - last : 0);
    seen.push(`${at / 1000}s +${now.packets - last} pc ${now.state} call ${on ? "on" : "OFF"} service ${callService(app)}${silenced(app) ? " mic silenced" : ""}`);
    last = now.packets;
  }
  back();
  console.log(`  [${label}] in front ${front.join(", ")} per ${STEP_MS / 1000} s; away:\n    ${seen.join("\n    ")}`);
  return { front, late, seen };
}

/** The web peer hangs up: the app's call service goes with the call. */
async function hangUp(app: AndroidApp, web: Peer) {
  await web.page.getByTitle("End call").click();
  await expect.poll(() => callService(app), { message: "the call service stopped with the call", timeout: 20_000 }).toBe("none");
}

test.beforeEach(({}, testInfo) => testInfo.setTimeout(5 * 60_000 + 2 * AWAY_MS));

test("a call keeps going with the app in the background", { tag: ["@feature:android.calls.background", "@gated"] }, async ({ app, webPeer }) => {
  const web = await webPeer("web-call-bg");
  await pairWithWeb(app, web);
  const { front, late, seen } = await callAndAway(app, web, app.background, app.foreground, "home");
  expect(Math.min(...late), `audio kept coming with the app in the background (in front ${front.join(", ")}): ${seen.join(" / ")}`).toBeGreaterThan(front[1] / 2);
  await hangUp(app, web);
});

test("a call keeps going with the screen off", { tag: ["@feature:android.calls.background", "@gated"] }, async ({ app, webPeer }) => {
  const web = await webPeer("web-call-off");
  await pairWithWeb(app, web);
  const off = () => void app.adb.run("shell", "input", "keyevent", "KEYCODE_SLEEP");
  const on = () => {
    app.adb.run("shell", "input", "keyevent", "KEYCODE_WAKEUP");
    app.adb.tryRun("shell", "wm", "dismiss-keyguard");
  };
  const { front, late, seen } = await callAndAway(app, web, off, on, "screen-off");
  expect(Math.min(...late), `audio kept coming with the screen off (in front ${front.join(", ")}): ${seen.join(" / ")}`).toBeGreaterThan(front[1] / 2);
  await hangUp(app, web);
});

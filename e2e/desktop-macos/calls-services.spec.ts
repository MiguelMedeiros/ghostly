import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { BIG_SHA256, startAtlas } from "../../extension/test/atlas.mjs";
import { desktopPerson, type DesktopPerson } from "../matrix/people";
import { HYPERDHT_TESTNET } from "../matrix/desktop";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";
import { LocalRelay } from "../support/relay";

/**
 * Two Ghostly Desktop apps on one Mac, in the system WKWebView, pair and use a chat's live session for what
 * only a live session carries (#207): a video call with media both ways (`calls/1`), and a local web app one
 * of them shares, opened by the other in a window of its own (`services/1`). On the DHT the call buttons are
 * off and say why.
 *
 * The Linux Desktop harness (e2e/desktop/) cannot show the calls: WebKitGTK has no WebRTC for their media (a Linux
 * pair goes live on Iroh or HyperDHT, e2e/desktop/native-upgrade.spec.ts, but cannot call). macOS has no WebDriver for WKWebView, so the apps are driven through the test driver built
 * into a debug build (support/desktopMac.ts). The Pkarr relay, the HyperDHT network and the shared app are in
 * this process; the call's STUN lookups (and the wallets' providers, which the apps reach at start) are not.
 *
 * Camera and microphone: none are used. A WKWebView has no flag for Chromium's fake devices, so before the
 * call each app's `getUserMedia` is answered with a synthetic stream — an oscillator (Web Audio) and a canvas
 * that changes every frame (`captureStream`). It is replaced on `MediaDevices.prototype`: replaced on the
 * `navigator.mediaDevices` instance, the answering app sometimes still reached WebKit's own, which with no
 * camera fails with "OverconstrainedError: Invalid constraint". Everything after it — the peer connection, the
 * codecs, the <video> — is the app's own, and the stats of each side's connection show the other side's media
 * arriving and being decoded.
 *
 * What it found on its first runs, both fixed in packages/core/src/callSignal.ts: an IPv6 srflx candidate
 * (`raddr ::`) made the receiver drop the whole offer (no ring), and the SDP rebuilt from the compact signal
 * said `96 VP8` where WebKit had offered H264 as 96, so the caller never decoded the callee's picture.
 *
 *   npm run desktop:macos:build
 *   npm run test:e2e:desktop-macos
 */

// 49700-49799: this test's ports.
const PORTS = { relay: 49701, dht: 49702, atlas: 49703, a: 49710, b: 49711 };

const clock = /\b\d{1,2}:\d{2}\b/;

/** Synthetic camera and microphone, and a list of the page's peer connections (for their stats). Idempotent. */
const FAKE_MEDIA = `
  if (window.__e2eMedia) return;
  window.__e2eMedia = true;
  window.__e2ePeers = [];
  // What the page complained about, for the report.
  window.__e2eLog = [];
  for (const level of ["error", "warn"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => { window.__e2eLog.push(level + ": " + args.map(String).join(" ")); original(...args); };
  }
  addEventListener("error", (e) => window.__e2eLog.push("error: " + e.message));
  addEventListener("unhandledrejection", (e) => window.__e2eLog.push("rejection: " + String(e.reason)));
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(...args) { super(...args); window.__e2ePeers.push(this); }
  };
  // A step of the call that WebKit refuses says so in the report.
  for (const step of ["setRemoteDescription", "setLocalDescription", "createAnswer", "createOffer", "addIceCandidate"]) {
    const original = Native.prototype[step];
    window.RTCPeerConnection.prototype[step] = function (...args) {
      return original.apply(this, args).catch((error) => {
        window.__e2eLog.push(step + ": " + error.name + ": " + error.message + (args[0]?.sdp ? "\\n" + args[0].sdp : ""));
        throw error;
      });
    };
  }
  const camera = () => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 320, height: 240 });
    canvas.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none";
    document.body.append(canvas);
    const g = canvas.getContext("2d");
    let n = 0;
    setInterval(() => {
      g.fillStyle = "hsl(" + ((n++ * 9) % 360) + " 80% 50%)";
      g.fillRect(0, 0, 320, 240);
      g.fillStyle = "#fff";
      g.fillText(String(n), 12, 24);
    }, 66);
    return canvas.captureStream(15).getVideoTracks();
  };
  const microphone = () => {
    const context = new AudioContext();
    const tone = context.createOscillator();
    const out = context.createMediaStreamDestination();
    tone.frequency.value = 440;
    tone.connect(out);
    tone.start();
    void context.resume();
    return out.stream.getAudioTracks();
  };
  // On the prototype: the instance on navigator is not the only one the app may be handed.
  MediaDevices.prototype.getUserMedia = async (constraints = {}) => {
    try {
      const stream = new MediaStream([...(constraints.audio ? microphone() : []), ...(constraints.video ? camera() : [])]);
      window.__e2eLog.push("getUserMedia " + JSON.stringify(constraints) + " -> " + stream.getTracks().map((t) => t.kind).join(","));
      return stream;
    } catch (error) {
      window.__e2eLog.push("getUserMedia " + JSON.stringify(constraints) + " failed: " + error.name + ": " + error.message);
      throw error;
    }
  };
`;

/** Bytes (and decoded frames) of media each of the page's live peer connections receives. */
const RECEIVED = `
  const done = arguments[arguments.length - 1];
  Promise.all((window.__e2ePeers ?? []).filter((pc) => pc.connectionState !== "closed").map(async (pc) => {
    const got = { audio: 0, video: 0, frames: 0, sent: 0, state: pc.connectionState };
    (await pc.getStats()).forEach((s) => {
      if (s.type === "outbound-rtp") got.sent += s.bytesSent ?? 0;
      if (s.type !== "inbound-rtp") return;
      got[s.kind] += s.bytesReceived ?? 0;
      if (s.kind === "video") got.frames += s.framesDecoded ?? 0;
    });
    return got;
  })).then((all) => done(all.reduce((sum, got) => ({ audio: sum.audio + got.audio, video: sum.video + got.video, frames: sum.frames + got.frames, sent: sum.sent + got.sent, states: sum.states + got.state + " " }),
    { audio: 0, video: 0, frames: 0, sent: 0, states: "" })));
`;

type Received = { audio: number; video: number; frames: number; sent: number; states: string };

/** The size of the other side's picture, as this app's call shows it. */
const REMOTE_PICTURE = `
  const video = [...document.querySelectorAll("video")].find((v) => !v.muted);
  return video ? video.videoWidth + "x" + video.videoHeight : "none";`;

const pageText = (p: DesktopPerson) => p.snapshot();

/** Polls `read` until `done` holds; a timeout says what was last read. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout: number, what: string): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what}: not after ${timeout / 1000} s; last read ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test("two Desktop apps on a Mac pair, call with media both ways, share an app, and say why not on the DHT", {
  tag: ["@client:desktop", "@feature:calls.paired", "@feature:calls.video", "@feature:calls.paired.negotiate", "@feature:calls.paired.live-only",
    "@feature:services.add", "@feature:services.share", "@feature:services.open", "@feature:services.paired.negotiate", "@feature:services.desktop-viewer"],
}, async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "macOS only: the system WKWebView");
  const relay = new LocalRelay();
  const { default: testnet } = (await import(HYPERDHT_TESTNET)) as { default: (size: number, opts?: { port?: number }) => Promise<{ bootstrap: { host: string; port: number }[]; destroy(): Promise<void> }> };
  const dht = await testnet(3, { port: PORTS.dht });
  const atlas = await startAtlas(PORTS.atlas);
  const env = {
    GHOSTLY_PKARR_RELAYS: await relay.listen(PORTS.relay),
    GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap.map((node) => `${node.host}:${node.port}`).join(","),
  };
  const apps: MacDesktop[] = [];
  forgetSharedData();
  const open = (name: "a" | "b") => async () => {
    const desktop = await openMacDesktop({ name, port: PORTS[name], env });
    apps.push(desktop);
    return { app: desktop.app, stop: () => desktop.stop() };
  };
  let a: DesktopPerson | undefined, b: DesktopPerson | undefined;
  // Written out whole (the list reporter cuts an attachment short) and attached.
  const keep = async (name: string, body: string) => {
    writeFileSync(testInfo.outputPath(name), body);
    await testInfo.attach(name, { path: testInfo.outputPath(name), contentType: "text/plain" });
  };
  try {
    [a, b] = await Promise.all([desktopPerson("a", { env, open: open("a") }), desktopPerson("b", { env, open: open("b") })]);
    const [alice, bob] = [a, b];

    await test.step("pair: A's ghostly1 invite, joined by B, goes live", async () => {
      await alice.press("New Chat");
      const invite = await alice.copyInvite();
      expect(invite).toMatch(/^https:\/\/ghostly\.tools\/#ghostly1/);
      await bob.join(invite);
      for (const p of [alice, bob]) {
        await expect.poll(() => p.canWrite(), { timeout: 120_000, message: `${p.name}'s chat is up` }).toBe(true);
        p.chatHash = await p.hash();
        await expect.poll(() => p.connection(), { timeout: 120_000, message: `${p.name} is live` }).toMatch(/Connected ·/);
      }
      testInfo.annotations.push({ type: "transport", description: await alice.connection() });
    });

    await test.step("call: A calls with video, B answers, media flows both ways, A hangs up", async () => {
      for (const p of [alice, bob]) await p.app.execute(FAKE_MEDIA);
      // Both apps offered calls/1 on the live session: the buttons are on, with no reason to show.
      for (const p of [alice, bob]) {
        await expect.poll(() => p.app.attribute('[data-testid="call-video"]', "title"), { timeout: 60_000 }).toBe("Video call");
        expect(await p.app.execute<boolean>(`return document.querySelector('[data-testid="call-video"]').disabled;`)).toBe(false);
      }
      await alice.app.click('[data-testid="call-video"]');
      await expect.poll(() => pageText(bob), { timeout: 60_000 }).toContain("Incoming video call");
      await bob.app.click('[title="Accept video call"]');
      for (const p of [alice, bob]) await expect.poll(() => p.app.text('[title="End call"]'), { timeout: 60_000, message: `${p.name} is on the call` }).not.toBeNull();

      for (const p of [alice, bob]) {
        const received = () => p.app.executeAsync<Received>(RECEIVED);
        await until(received, (r) => r.audio > 0 && r.video > 0 && r.frames > 0, 60_000, `${p.name} receives the other side's sound and picture`);
        const before = await received();
        // Still flowing, not a burst at the start.
        await until(received, (r) => r.audio > before.audio && r.frames > before.frames, 30_000, `${p.name}'s media keeps coming`);
        await expect.poll(() => p.app.execute<string>(REMOTE_PICTURE), { timeout: 30_000, message: `${p.name} shows the other side's picture` }).toMatch(/^[1-9]\d*x[1-9]\d*$/);
        testInfo.annotations.push({ type: `${p.name} received`, description: JSON.stringify(await received()) });
      }
      expect(await pageText(alice)).toMatch(clock);

      await alice.press("End call");
      for (const p of [alice, bob]) {
        await expect.poll(() => p.app.text('[title="End call"]'), { timeout: 30_000 }).toBeNull();
        await expect.poll(() => pageText(p), { timeout: 30_000, message: `${p.name}'s chat says the call ended` }).toContain("Video call ended");
      }
      // Once over, another call could start from either side.
      await expect.poll(() => bob.callButton(), { timeout: 30_000 }).toMatchObject({ disabled: false });
    });

    await test.step("services: A shares a local app, B opens it from the chat and gets its answers", async () => {
      await alice.go("#/services");
      await alice.app.click('[data-testid="add-service"]');
      await expect.poll(() => alice.app.text('[data-testid="service-name"]')).not.toBeNull();
      await alice.app.type('[data-testid="service-name"]', "Atlas");
      await alice.app.type('[data-testid="service-target"]', `localhost:${PORTS.atlas}`);
      await alice.app.click('[data-testid="service-save"]');
      await expect.poll(() => alice.app.text('[data-testid="your-apps"]')).toContain("Atlas");

      await alice.go(alice.chatHash!);
      // Just after the chat opens it may draw its header again, and a click on the old one is lost: again until the menu is up.
      await expect(async () => {
        if ((await alice.app.attribute('[data-testid="chat-options"]', "aria-expanded")) !== "true") await alice.app.click('[data-testid="chat-options"]');
        expect(await alice.app.text('[data-testid="chat-services-open"]'), "the chat's menu").not.toBeNull();
      }).toPass({ timeout: 30_000 });
      await alice.app.click('[data-testid="chat-services-open"]');
      await expect.poll(() => alice.app.text('[data-testid="chat-service-toggle"]')).not.toBeNull();
      // Both apps offer services/1 and the chat is live: nothing to explain.
      expect(await alice.app.text('[data-testid="chat-services-unavailable"]')).toBeNull();
      await alice.app.click('[data-testid="chat-service-toggle"]');
      await expect.poll(() => alice.app.attribute('[data-testid="chat-service-toggle"]', "aria-checked")).toBe("true");
      await alice.press("Done");

      // B's app, for the window the shared app opens in.
      const driver = apps.find((d) => d.bundleId.endsWith(".b"))!.app;
      await expect.poll(() => bob.app.text('[data-testid="open-service"]'), { timeout: 120_000, message: "B sees A's app in the chat" }).toContain("Atlas");
      const before = new Set(await driver.windows());
      await bob.app.click('[data-testid="open-service"]');
      let label = "";
      await expect.poll(async () => (label = (await driver.windows()).find((w) => !before.has(w)) ?? ""), { timeout: 30_000, message: "B opens it in a window" }).not.toBe("");
      const viewer = driver.in(label);
      // Atlas's page runs its module, fetches JSON, a redirect, a 3 MB file and a 404 from A's machine, then says it is ready.
      await expect.poll(() => viewer.execute<string | null>(`return document.body?.dataset.ready ?? null;`).catch(() => null), { timeout: 150_000, message: "the app loaded in B's window" }).toBe("1");
      const out = JSON.parse((await viewer.text("#out")) ?? "{}") as { echo?: { body?: { hello?: string }; header?: string }; bigSha?: string; missing?: number; image?: number; css?: string };
      expect(out).toMatchObject({ echo: { body: { hello: "ghost" }, header: "yes" }, bigSha: BIG_SHA256, missing: 404, image: 1, css: "rgb(1, 2, 3)" });
      expect(atlas.requests.some((r: { path: string }) => r.path === "/lib/hash.js"), "requests reached A's localhost").toBe(true);
      await viewer.execute(`window.close();`).catch(() => {});
    });

    await test.step("DHT only: the call buttons are off and say why, and come back live", async () => {
      const dhtOnly = async (p: DesktopPerson, on: boolean) => {
        await p.go(p.chatHash!);
        if ((await p.app.attribute('[data-testid="connection-menu"]', "open")) === null) await p.app.click('[data-testid="connection-options"]');
        const toggle = 'input[role="switch"][aria-label="DHT-only delivery"]';
        await expect.poll(() => p.app.attribute(toggle, "aria-checked"), { message: `${p.name}'s DHT-only switch` }).not.toBeNull();
        if ((await p.app.attribute(toggle, "aria-checked")) !== String(on)) await p.app.click(toggle);
        await expect.poll(() => p.app.attribute(toggle, "aria-checked")).toBe(String(on));
        await p.app.execute(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));`);
      };
      for (const p of [alice, bob]) await dhtOnly(p, true);
      for (const p of [alice, bob]) {
        await expect.poll(() => p.connection(), { timeout: 60_000 }).toMatch(/DHT only/);
        for (const id of ["call-audio", "call-video"]) {
          await expect.poll(() => p.app.execute(`const b = document.querySelector('[data-testid="${id}"]'); return b && { disabled: b.disabled, title: b.title };`),
            { timeout: 60_000, message: `${p.name}'s ${id} is off and says why` }).toEqual({ disabled: true, title: "Calls need a live connection" });
        }
      }
      for (const p of [alice, bob]) await dhtOnly(p, false);
      for (const p of [alice, bob]) await expect.poll(() => p.callButton(), { timeout: 150_000, message: `${p.name} can call again` }).toMatchObject({ disabled: false, title: "Audio call" });
    });
  } catch (error) {
    // What each app showed and printed, for the report.
    for (const p of [a, b]) {
      if (!p) continue;
      const complaints = await p.app.execute<string[] | null>(`return window.__e2eLog ?? null;`).catch(() => null);
      const sdp = await p.app.execute<string[] | null>(`return (window.__e2ePeers ?? []).map((pc) => pc.connectionState + "\\n" + (pc.localDescription?.sdp ?? "") + "\\n---remote---\\n" + (pc.remoteDescription?.sdp ?? ""));`).catch(() => null);
      if (sdp?.length) await keep(`${p.name}-call-sdp.txt`, sdp.join("\n\n======\n\n"));
      await keep(`${p.name}-page.txt`, `${await p.snapshot().catch((e: unknown) => String(e))}\n\n--- console ---\n${(complaints ?? []).join("\n")}`);
    }
    for (const d of apps) await keep(`${d.bundleId}-log.txt`, d.log.join(""));
    throw error;
  } finally {
    await Promise.all(apps.map((d) => d.stop()));
    forgetSharedData();
    await atlas.server.close();
    relay.close();
    await dht.destroy();
  }
});

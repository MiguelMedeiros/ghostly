import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildDataSdp, DATA_CHANNEL_ID, DATA_CHANNEL_LABEL, extractRtcParams, parseRtcSignal, type RtcSignal } from "@ghostly/core";
import { profilePaths, type ProfilePaths } from "../src/profiles";
import type { Runtime } from "../src/runtime/engine";
import { isolatedNetworkEnv } from "./support/network";
// covers: headless.daemon, settings.network.relay-only

/*
 * Hide my IP from contacts (`relayOnly`) on a CLI profile. node-datachannel's libdatachannel keeps only its own host
 * candidates out of the SDP under `iceTransportPolicy: "relay"`: its ICE still checks from this machine's sockets, and
 * a contact's offer answered so comes up directly, the contact seeing this machine's address. So while it is on, the
 * CLI's chats and group edges make no WebRTC connection at all (`webrtcIgnoresRelayOnly`), as its calls do not: neither
 * an offer nor an answer. A profile that arrives with it already on (a copy of an app's store, a move) is the same.
 *
 * The runtime is the daemon's own (`startRuntime`) with node-datachannel, in this process, on this machine only. The
 * contact is a plain node-datachannel connection with no servers; the TURN server is a loopback port nobody listens on.
 */

const TURN = { urls: "turn:127.0.0.1:5601", username: "u", credential: "p" };
const root = mkdtempSync(join(tmpdir(), "ghostly-relay-only-rtc-"));
const env = isolatedNetworkEnv();
const before: Record<string, string | undefined> = {};
const scope = globalThis as unknown as { RTCPeerConnection: typeof RTCPeerConnection };
let polyfill: typeof RTCPeerConnection;
let runtime: Runtime | undefined;
/** Each connection the engine made since the runtime started: its configuration. */
let made: (RTCConfiguration | undefined)[] = [];
const contacts: RTCPeerConnection[] = [];

beforeAll(async () => {
  for (const [key, value] of Object.entries(env)) { before[key] = process.env[key]; process.env[key] = value; }
  polyfill = (await import("node-datachannel/polyfill")).RTCPeerConnection as unknown as typeof RTCPeerConnection;
});

afterEach(async () => {
  for (const pc of contacts.splice(0)) pc.close();
  await runtime?.close();
  runtime = undefined;
});

afterAll(() => {
  for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

async function start(paths: ProfilePaths): Promise<Runtime> {
  // A runtime per module graph: the engine keeps the store it opened.
  vi.resetModules();
  runtime = await (await import("../src/runtime/engine")).startRuntime(paths);
  expect(runtime.webrtc).toBe(true);
  // Counted from here: the engine looks the class up at each connection it makes.
  made = [];
  const Base = scope.RTCPeerConnection;
  scope.RTCPeerConnection = class extends Base {
    constructor(config?: RTCConfiguration) { super(config); made.push(config); }
  };
  return runtime;
}

function profile(name: string): ProfilePaths {
  const paths = profilePaths(join(root, "home"), name);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  return paths;
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  return new Promise(resolve => {
    if (pc.iceGatheringState === "complete") return resolve();
    pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") resolve(); });
    setTimeout(resolve, 5_000);
  });
}

/**
 * A contact's offer handed to a chat's data link, as its packet would: the answer the chat publishes, if any, applied
 * on the contact's side, and whether their channel then opens (only directly: there is no relay to go through).
 */
type ChatLink = { availableTransports: string[]; dataLink: { connect(): Promise<unknown>; handleSignal(json: string): Promise<void>; options: { publishSignal(json: string): void } } };
const chatLink = (node: Runtime["server"]["node"], linkId: string) =>
  (node as unknown as { links: Map<string, { link: ChatLink | null }> }).links.get(linkId)!.link!;

/** The offer the chat's data link publishes when it dials, if any. */
async function offerToContact(node: Runtime["server"]["node"], linkId: string): Promise<RtcSignal | null> {
  const link = chatLink(node, linkId);
  const offers: RtcSignal[] = [];
  link.dataLink.options.publishSignal = json => { const signal = parseRtcSignal(json); if (signal?.t === "o") offers.push(signal); };
  await link.dataLink.connect();
  return offers[0] ?? null;
}

async function offerFromContact(node: Runtime["server"]["node"], linkId: string): Promise<{ answer: RtcSignal | null; open: boolean }> {
  const link = chatLink(node, linkId);
  const answers: RtcSignal[] = [];
  link.dataLink.options.publishSignal = json => { const signal = parseRtcSignal(json); if (signal?.t === "a") answers.push(signal); };
  const contact = new polyfill({ iceServers: [] });
  contacts.push(contact);
  const channel = contact.createDataChannel(DATA_CHANNEL_LABEL, { negotiated: true, id: DATA_CHANNEL_ID, ordered: true });
  const opened = new Promise<boolean>(resolve => { channel.addEventListener("open", () => resolve(true)); setTimeout(() => resolve(false), 10_000); });
  await contact.setLocalDescription(await contact.createOffer());
  await gathered(contact);
  const offer: RtcSignal = { t: "o", ts: Date.now(), ...extractRtcParams(contact.localDescription!.sdp) };
  await link.dataLink.handleSignal(JSON.stringify(offer));
  const answer = answers[0] ?? null;
  if (!answer) return { answer, open: false };
  await contact.setRemoteDescription({ type: "answer", sdp: buildDataSdp(answer) });
  return { answer, open: await opened };
}

describe("a CLI profile with Hide my IP from contacts", () => {
  it("answers a contact's offer with no WebRTC connection while it is on, and directly with it off", async () => {
    const { server } = await start(profile("switched"));
    const node = server.node;
    const { linkId } = await node.createLink();

    // Off: as before, the chat answers over WebRTC with this machine's candidates, and the channel opens.
    const off = await offerFromContact(node, linkId);
    expect(made.length).toBeGreaterThan(0);
    expect(off.answer?.c.length).toBeGreaterThan(0);
    expect(off.open).toBe(true);
    expect(node.getState().transport.webrtc).toBeUndefined();

    // On (a raw engine call: the CLI's own API refuses it): no connection is made for the offer, nothing is answered.
    await node.updateSettings({ settings: { iceServers: [TURN], relayOnly: true } });
    made = [];
    const on = await offerFromContact(node, linkId);
    expect(on).toEqual({ answer: null, open: false });
    // Nor does it offer one, or say it runs WebRTC.
    expect(chatLink(node, linkId).availableTransports).not.toContain("webrtc/1");
    expect(await offerToContact(node, linkId)).toBeNull();
    expect(made).toEqual([]);
    expect(node.getState().transport.webrtc).toBe(false);
  }, 60_000);

  it("makes no WebRTC connection for a contact when the profile arrives with it already on", async () => {
    const paths = profile("arrived");
    const first = await start(paths);
    const { linkId } = await first.server.node.createLink();
    await first.server.node.updateSettings({ settings: { iceServers: [TURN], relayOnly: true } });
    await first.close();
    runtime = undefined;

    // Started again on that store, as a copy of an app's with Hide my IP on would be.
    const { server } = await start(paths);
    const node = server.node;
    expect(node.getState().settings.relayOnly).toBe(true);
    const on = await offerFromContact(node, linkId);
    expect(on).toEqual({ answer: null, open: false });
    expect(chatLink(node, linkId).availableTransports).not.toContain("webrtc/1");
    expect(await offerToContact(node, linkId)).toBeNull();
    expect(made).toEqual([]);
    expect(node.getState().transport.webrtc).toBe(false);
  }, 60_000);
});

import type { BrowserContext, Page } from "@playwright/test";

/**
 * What a call's WebRTC connection did in a page, for a call that never connected: the report shows two call windows
 * saying "Connecting..." and nothing of why. `watchCalls` records every RTCPeerConnection the page makes from then on
 * (the app makes the call's own when the call starts), with its events; `callTrace` reads them back as text.
 *
 * `watchLink` and `linkTrace` do the same for a chat's own link, where the engine runs: the page on the web, the
 * offscreen document in the extension. They also keep the engine's link trace (packages/core/src/linkTrace.ts).
 */
export async function watchCalls(page: Page): Promise<void> {
  await page.evaluate(recordConnections);
}

/** The recorded connections of a page, as text: states, events, both descriptions' ICE lines and the pairs tried. */
export async function callTrace(page: Page): Promise<string> {
  if (page.isClosed()) return "(page closed)";
  return page.evaluate(readConnections);
}

/** Where a person's engine runs: the page itself, or (the extension) its offscreen document. */
export interface EngineHost {
  kind: "web" | "extension";
  context: BrowserContext;
  page: Page;
}

/** Records the chat link's connections and its link trace from now on, where the engine runs. */
export async function watchLink(host: EngineHost): Promise<void> {
  await inEngine(host, `(${recordConnections})(); (${recordLinkTrace})()`);
}

/** The chat link's connections and link trace since `watchLink`, as text. */
export async function linkTrace(host: EngineHost): Promise<string> {
  return inEngine<string>(host, `(async () => [await (${readConnections})(), "link trace:", ...(globalThis.__linkLines ?? ["(none)"])].join("\\n"))()`);
}

/** How many connections the engine made since `watchLink`, and how many of them had no candidate in their description. */
export async function linkConnections(host: EngineHost): Promise<{ made: number; empty: number }> {
  return inEngine(host, `(() => { const pcs = globalThis.__callPcs ?? []; return { made: pcs.length,
    empty: pcs.filter((r) => r.pc.localDescription && !/^a=candidate:/m.test(r.pc.localDescription.sdp)).length }; })()`);
}

async function inEngine<T>(host: EngineHost, source: string): Promise<T> {
  if (host.kind === "web") {
    if (host.page.isClosed()) throw new Error("page closed");
    return host.page.evaluate(source) as Promise<T>;
  }
  // The extension's offscreen document is no page to Playwright: it is reached through the page's CDP session.
  const session = await host.context.newCDPSession(host.page);
  try {
    const { targetInfos } = await session.send("Target.getTargets");
    const target = targetInfos.find((t) => t.url.endsWith("/offscreen.html"));
    if (!target) throw new Error("no offscreen document");
    const { sessionId } = await session.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
    type Answer = { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }; error?: { message: string } };
    const reply = new Promise<Answer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("offscreen document did not answer")), 15_000);
      session.on("Target.receivedMessageFromTarget", (event) => {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message) as Answer;
        if (message.id === 1) { clearTimeout(timer); resolve(message); }
      });
    });
    await session.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: source, awaitPromise: true, returnByValue: true } }),
    });
    const answer = await reply;
    await session.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    if (answer.error) throw new Error(answer.error.message);
    const failed = answer.result?.exceptionDetails;
    if (failed) throw new Error(failed.exception?.description ?? failed.text ?? "failed");
    return answer.result?.result?.value as T;
  } finally {
    await session.detach().catch(() => {});
  }
}

/* The functions below run in the browser (a page, or the offscreen document): nothing from this module is in scope. */

function recordConnections(): void {
  type Rec = { pc: RTCPeerConnection; at: number; log: string[] };
  const w = globalThis as unknown as { __callPcs?: Rec[]; RTCPeerConnection: typeof RTCPeerConnection };
  if (w.__callPcs) return;
  const pcs: Rec[] = (w.__callPcs = []);
  const Native = w.RTCPeerConnection;
  w.RTCPeerConnection = class extends Native {
    constructor(config?: RTCConfiguration) {
      super(config);
      const rec: Rec = { pc: this, at: Date.now(), log: [] };
      pcs.push(rec);
      const note = (text: string) => rec.log.push(`${Date.now() - rec.at}ms ${text}`);
      this.addEventListener("icecandidate", (e) => note(`candidate ${e.candidate?.candidate ?? "(end)"}`));
      this.addEventListener("icecandidateerror", (e) => note(`candidate error ${(e as RTCPeerConnectionIceErrorEvent).url} ${(e as RTCPeerConnectionIceErrorEvent).errorCode}`));
      this.addEventListener("icegatheringstatechange", () => note(`gathering ${this.iceGatheringState}`));
      this.addEventListener("iceconnectionstatechange", () => note(`ice ${this.iceConnectionState}`));
      this.addEventListener("connectionstatechange", () => note(`connection ${this.connectionState}`));
      this.addEventListener("signalingstatechange", () => note(`signaling ${this.signalingState}`));
      const wrap = (name: "setLocalDescription" | "setRemoteDescription") => {
        const original = this[name].bind(this) as (d?: RTCSessionDescriptionInit) => Promise<void>;
        (this as unknown as Record<string, unknown>)[name] = (d?: RTCSessionDescriptionInit) => {
          note(`${name} ${d?.type ?? ""}`);
          return original(d).then(
            () => note(`${name} done`),
            (error: unknown) => { note(`${name} failed ${error}`); throw error; },
          );
        };
      };
      wrap("setLocalDescription");
      wrap("setRemoteDescription");
    }
  } as typeof RTCPeerConnection;
}

/** The engine's link trace lines (`[ghostly:link] …`), kept in memory rather than printed. */
function recordLinkTrace(): void {
  const w = globalThis as unknown as { __linkLines?: string[]; __ghostlyLinkTrace?: boolean };
  if (w.__linkLines) return;
  const lines: string[] = (w.__linkLines = []);
  const debug = console.debug.bind(console);
  console.debug = (...args: unknown[]) => {
    const [first] = args;
    if (typeof first === "string" && first.startsWith("[ghostly:link] ")) {
      lines.push(first.slice(15));
      if (lines.length > 3000) lines.splice(0, 1000);
      return;
    }
    debug(...args);
  };
  w.__ghostlyLinkTrace = true;
}

async function readConnections(): Promise<string> {
  type Rec = { pc: RTCPeerConnection; at: number; log: string[] };
  const pcs = (globalThis as unknown as { __callPcs?: Rec[] }).__callPcs;
  if (!pcs) return "(not watched)";
  const iceLines = (sdp?: string) => (sdp ?? "").split("\r\n").filter((l) => /^a=(ice-ufrag|candidate|setup|fingerprint)/.test(l));
  const out: string[] = [`${pcs.length} connection(s)`];
  for (const [i, { pc, at, log }] of pcs.entries()) {
    out.push(`#${i} made ${new Date(at).toISOString()}: signaling ${pc.signalingState}, gathering ${pc.iceGatheringState}, ice ${pc.iceConnectionState}, connection ${pc.connectionState}`);
    out.push(`  servers ${JSON.stringify(pc.getConfiguration().iceServers?.map((s) => s.urls))}`);
    out.push("  events:", ...log.map((l) => `    ${l}`));
    out.push("  local:", ...iceLines(pc.localDescription?.sdp).map((l) => `    ${l}`));
    out.push("  remote:", ...iceLines(pc.remoteDescription?.sdp).map((l) => `    ${l}`));
    if (pc.signalingState === "closed") continue;
    const stats = await pc.getStats().catch(() => null);
    const byId = new Map<string, Record<string, unknown>>();
    stats?.forEach((s: Record<string, unknown>) => byId.set(s.id as string, s));
    const where = (id: unknown) => {
      const c = byId.get(id as string);
      return c ? `${c.candidateType} ${c.address ?? c.ip}:${c.port} ${c.protocol}` : String(id);
    };
    out.push("  pairs:");
    for (const s of byId.values()) {
      if (s.type !== "candidate-pair") continue;
      out.push(`    ${where(s.localCandidateId)} -> ${where(s.remoteCandidateId)}: ${s.state}${s.nominated ? " nominated" : ""} req ${s.requestsSent}/${s.requestsReceived} res ${s.responsesSent}/${s.responsesReceived}`);
    }
    for (const s of byId.values()) if (s.type === "transport") out.push(`  transport: ice ${s.iceState} dtls ${s.dtlsState} role ${s.iceRole} selected ${s.selectedCandidatePairId ?? "-"}`);
  }
  return out.join("\n");
}

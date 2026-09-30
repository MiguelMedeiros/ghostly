import type { Page } from "@playwright/test";

/**
 * What a call's WebRTC connection did in a page, for a call that never connected: the report shows two call windows
 * saying "Connecting..." and nothing of why. `watchCalls` records every RTCPeerConnection the page makes from then on
 * (the app makes the call's own when the call starts), with its events; `callTrace` reads them back as text.
 */
export async function watchCalls(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Rec = { pc: RTCPeerConnection; at: number; log: string[] };
    const w = window as unknown as { __callPcs?: Rec[]; RTCPeerConnection: typeof RTCPeerConnection };
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
  });
}

/** The recorded connections of a page, as text: states, events, both descriptions' ICE lines and the pairs tried. */
export async function callTrace(page: Page): Promise<string> {
  if (page.isClosed()) return "(page closed)";
  return page.evaluate(async () => {
    type Rec = { pc: RTCPeerConnection; at: number; log: string[] };
    const pcs = (window as unknown as { __callPcs?: Rec[] }).__callPcs;
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
  });
}

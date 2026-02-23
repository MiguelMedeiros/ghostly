import type { CallSignal } from "./types";

export function compressSdp(sdp: string): string {
  return btoa(sdp);
}

export function decompressSdp(compressed: string): string {
  return atob(compressed);
}

export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
  ],
  iceCandidatePoolSize: 10,
};

export function extractParamsFromSdp(sdp: string): Partial<CallSignal> {
  const lines = sdp.split("\r\n");

  let ufrag = "";
  let pwd = "";
  let fingerprint = "";
  let setup = "";
  const media: string[] = [];
  const candidates: string[] = [];
  let audioSsrc: number | null = null;
  let videoSsrc: number | null = null;
  let currentMedia = "";

  for (const line of lines) {
    if (line.startsWith("a=ice-ufrag:") && !ufrag) {
      ufrag = line.substring("a=ice-ufrag:".length);
    }
    if (line.startsWith("a=ice-pwd:") && !pwd) {
      pwd = line.substring("a=ice-pwd:".length);
    }
    if (line.startsWith("a=fingerprint:sha-256 ") && !fingerprint) {
      fingerprint = line
        .substring("a=fingerprint:sha-256 ".length)
        .replace(/:/g, "");
    }
    if (line.startsWith("a=setup:") && !setup) {
      setup = line.substring("a=setup:".length);
    }
    if (line.startsWith("m=audio")) {
      media.push("a");
      currentMedia = "a";
    }
    if (line.startsWith("m=video")) {
      media.push("v");
      currentMedia = "v";
    }
    if (line.startsWith("a=candidate:")) {
      candidates.push(line.substring("a=candidate:".length));
    }
    if (line.startsWith("a=ssrc:")) {
      const ssrcMatch = line.match(/^a=ssrc:(\d+)/);
      if (ssrcMatch) {
        const ssrc = parseInt(ssrcMatch[1], 10);
        if (currentMedia === "a" && audioSsrc === null) {
          audioSsrc = ssrc;
        } else if (currentMedia === "v" && videoSsrc === null) {
          videoSsrc = ssrc;
        }
      }
    }
  }

  const srflxCandidates = candidates.filter(c => c.includes(" srflx "));
  const hostCandidates = candidates.filter(c => c.includes(" host ") && c.includes(" udp "));
  // Include 1 host candidate (for local connections) and 1 srflx (for remote)
  // Keep packet size under 1000 bytes DHT limit
  const selectedCandidates = [
    ...hostCandidates.slice(0, 1),
    ...srflxCandidates.slice(0, 1),
  ];
  
  const ssrcs: number[] = [];
  if (audioSsrc !== null) ssrcs.push(audioSsrc);
  if (videoSsrc !== null) ssrcs.push(videoSsrc);
  
  return {
    u: ufrag,
    p: pwd,
    f: fingerprint,
    s: setup,
    m: media,
    c: selectedCandidates,
    ss: ssrcs,
  };
}

export function buildSdpFromSignal(
  signal: CallSignal,
  type: "offer" | "answer",
): string {
  const hexPairs = signal.f!.match(/.{2}/g)!;
  const fingerprint = `sha-256 ${hexPairs.join(":")}`;
  
  const mediaOrder = signal.m ?? ["a"];
  
  const sessionId = Math.floor(Math.random() * 1e15);
  const audioSsrc = signal.ss?.[0] ?? Math.floor(Math.random() * 0xFFFFFFFF);
  const videoSsrc = signal.ss?.[1] ?? Math.floor(Math.random() * 0xFFFFFFFF);

  const lines: string[] = [
    "v=0",
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    "s=-",
    "t=0 0",
  ];

  const mids = mediaOrder.map((_, i) => String(i));
  lines.push(`a=group:BUNDLE ${mids.join(" ")}`);
  lines.push("a=msid-semantic: WMS stream");

  mediaOrder.forEach((mediaType, idx) => {
    const mid = String(idx);
    
    if (mediaType === "a") {
      lines.push(
        "m=audio 9 UDP/TLS/RTP/SAVPF 111",
        "c=IN IP4 0.0.0.0",
        "a=rtcp:9 IN IP4 0.0.0.0",
      );
      for (const c of signal.c ?? []) {
        lines.push(`a=candidate:${c}`);
      }
      lines.push(
        "a=end-of-candidates",
        `a=ice-ufrag:${signal.u}`,
        `a=ice-pwd:${signal.p}`,
        `a=fingerprint:${fingerprint}`,
        `a=setup:${signal.s}`,
        `a=mid:${mid}`,
        "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
        "a=sendrecv",
        "a=msid:stream audio0",
        "a=rtcp-mux",
        "a=rtpmap:111 opus/48000/2",
        "a=fmtp:111 minptime=10;useinbandfec=1",
        `a=ssrc:${audioSsrc} cname:pkarr`,
        `a=ssrc:${audioSsrc} msid:stream audio0`,
      );
    } else if (mediaType === "v") {
      lines.push(
        "m=video 9 UDP/TLS/RTP/SAVPF 96",
        "c=IN IP4 0.0.0.0",
        "a=rtcp:9 IN IP4 0.0.0.0",
      );
      for (const c of signal.c ?? []) {
        lines.push(`a=candidate:${c}`);
      }
      lines.push(
        "a=end-of-candidates",
        `a=ice-ufrag:${signal.u}`,
        `a=ice-pwd:${signal.p}`,
        `a=fingerprint:${fingerprint}`,
        `a=setup:${signal.s}`,
        `a=mid:${mid}`,
        "a=extmap:2 urn:ietf:params:rtp-hdrext:toffset",
        "a=sendrecv",
        `a=msid:stream video0`,
        "a=rtcp-mux",
        "a=rtcp-rsize",
        "a=rtpmap:96 VP8/90000",
        "a=rtcp-fb:96 ccm fir",
        "a=rtcp-fb:96 nack",
        "a=rtcp-fb:96 nack pli",
        "a=rtcp-fb:96 goog-remb",
        `a=ssrc:${videoSsrc} cname:pkarr`,
        `a=ssrc:${videoSsrc} msid:stream video0`,
      );
    }
  });

  return lines.join("\r\n") + "\r\n";
}

export function waitForIceGathering(
  pc: RTCPeerConnection,
  timeoutMs = 10000,
): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") {
      console.log("[webrtc] ICE gathering already complete");
      resolve();
      return;
    }

    let candidateCount = 0;
    const timeout = setTimeout(() => {
      console.log(`[webrtc] ICE gathering timeout after ${timeoutMs}ms, collected ${candidateCount} candidates`);
      pc.removeEventListener("icegatheringstatechange", handler);
      pc.removeEventListener("icecandidate", candidateHandler);
      resolve();
    }, timeoutMs);

    const candidateHandler = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        candidateCount++;
      }
    };

    const handler = () => {
      if (pc.iceGatheringState === "complete") {
        console.log(`[webrtc] ICE gathering complete, collected ${candidateCount} candidates`);
        clearTimeout(timeout);
        pc.removeEventListener("icegatheringstatechange", handler);
        pc.removeEventListener("icecandidate", candidateHandler);
        resolve();
      }
    };

    pc.addEventListener("icecandidate", candidateHandler);
    pc.addEventListener("icegatheringstatechange", handler);
  });
}

// A mock of a Ghostly node's group-call token route (WISP 602), in front of the e2e stack's LiveKit server (--dev).
// It runs every check of WISP 602 § What the node checks, with a roster a test sets (PUT /test/roster/<g>) or the
// environment gives (SFU_TOKEN_ROSTERS), and answers with a LiveKit access token signed by the dev key. node:crypto
// only. It also serves a page with LiveKit's browser client (/smoke) for the stack's smoke spec.
import { createRequire } from "node:module";
import { createHmac, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";
const B64URL = /^[A-Za-z0-9_-]+$/;
const LIMIT = 30, MINUTE = 60_000;

/** A page that joins a room with a pass and publishes its camera; each remote camera plays in a <video data-identity>. */
const SMOKE = `<!doctype html><meta charset="utf-8"><title>SFU smoke</title><script src="/livekit-client.umd.js"></script>
<script>
window.joinCall = async (url, token) => {
  const { Room, RoomEvent, Track } = LivekitClient;
  const room = new Room();
  room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (track.kind !== Track.Kind.Video) return;
    const video = track.attach();
    video.dataset.identity = participant.identity;
    document.body.append(video);
  });
  await room.connect(url, token);
  await room.localParticipant.setCameraEnabled(true);
  window.room = room;
};
</script>`;

/** The 32 bytes of a z-base32 key in its one canonical spelling (52 characters, the last bits zero), or null. */
export function keyBytes(k) {
  if (typeof k !== "string" || k.length !== 52) return null;
  let bits = 0n;
  for (const c of k) {
    const v = ZBASE32.indexOf(c);
    if (v < 0) return null;
    bits = (bits << 5n) | BigInt(v);
  }
  if (bits & 0xfn) return null;
  return Buffer.from((bits >> 4n).toString(16).padStart(64, "0"), "hex");
}

/** The bytes a member's key signs for a token request (WISP 602 § The token request). */
export const signedBytes = (sfuOrigin, { g, room, k, ts, n }) => Buffer.from(JSON.stringify(["ghostly-sfu/1 token", sfuOrigin, g, room, k, ts, n]));

/** Whether `body` is a request of the right shape whose `sig` verifies under `k` for `sfuOrigin` (checks 1 and 4). */
export function verifyRequest(sfuOrigin, body) {
  const { v, g, k, room, ts, n, name, sig } = body ?? {};
  const shaped = v === 1 && typeof g === "string" && g.length === 22 && B64URL.test(g) && room === `g_${g}` && Number.isInteger(ts)
    && typeof n === "string" && n.length === 22 && B64URL.test(n) && typeof sig === "string" && sig.length === 86 && B64URL.test(sig)
    && (name === undefined || typeof name === "string");
  const key = shaped ? keyBytes(k) : null;
  if (!key) return false;
  const spki = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]), format: "der", type: "spki" });
  return verify(null, signedBytes(sfuOrigin, body), spki, Buffer.from(sig, "base64url"));
}

/** A LiveKit access token (HS256) that joins `room` and no other. */
export function accessToken({ apiKey, apiSecret, room, identity, name, ttl, now }) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = { iss: apiKey, sub: identity, jti: identity, name, nbf: now, exp: now + ttl, video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true } };
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}`;
  return `${unsigned}.${createHmac("sha256", apiSecret).update(unsigned).digest("base64url")}`;
}

/**
 * The service. `origin` is the https origin it answers for (what a group's `call.sfu` names), `livekitUrl` where the
 * clients' LiveKit SDK connects, `rosters` g → { k: name }. `now` is the clock, in milliseconds.
 */
export function startTokenService({ port = 0, host = "127.0.0.1", origin, livekitUrl, livekitHealth, apiKey = "devkey", apiSecret = "secret", rosters = {}, now = Date.now } = {}) {
  const roster = new Map(Object.entries(rosters));
  const nonces = new Map();
  const asked = new Map();
  const cors = { "access-control-allow-origin": "*" };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...cors, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  /** Past LIMIT requests in a minute from one address or for one key: the seconds to wait, else 0. */
  const limited = (...who) => {
    const t = now();
    let wait = 0;
    for (const id of who.filter(Boolean)) {
      const times = (asked.get(id) ?? []).filter((at) => t - at < MINUTE);
      times.push(t);
      asked.set(id, times);
      if (times.length > LIMIT) wait = Math.max(wait, Math.ceil((times[0] + MINUTE - t) / 1000));
    }
    return wait;
  };
  const read = (req) => new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => { size += chunk.length; if (size <= 4096) chunks.push(chunk); });
    req.on("end", () => resolve(size > 4096 ? null : Buffer.concat(chunks).toString("utf8")));
  });

  async function token(req, res) {
    const text = await read(req);
    let body = null;
    try { body = text === null ? null : JSON.parse(text); } catch { /* refused below */ }
    const wait = limited(`a:${req.socket.remoteAddress}`, typeof body?.k === "string" ? `k:${body.k}` : null);
    if (wait) return send(res, 429, { error: "slow down" }, { "retry-after": String(wait) });
    const t = now();
    for (const [n, at] of nonces) if (t - at > 120_000) nonces.delete(n);
    // One refusal for every check, so a caller is not told which one failed.
    const ok = verifyRequest(origin, body) && Math.abs(t / 1000 - body.ts) <= 60 && !nonces.has(body.n) && roster.get(body.g)?.[body.k] !== undefined;
    if (!ok) return send(res, 403, { error: "refused" });
    nonces.set(body.n, t);
    const name = [...(roster.get(body.g)[body.k] || body.name || "")].slice(0, 64).join("");
    const expiresIn = 600;
    const jwt = accessToken({ apiKey, apiSecret, room: body.room, identity: body.k, name, ttl: expiresIn, now: Math.floor(t / 1000) });
    send(res, 200, { url: livekitUrl, token: jwt, room: body.room, identity: body.k, expiresIn });
  }

  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/sfu/group-token" && req.method === "OPTIONS") return send(res, 204, undefined, { "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "Content-Type" });
    if (path === "/sfu/group-token" && req.method === "POST") return token(req, res);
    const group = /^\/test\/roster\/([A-Za-z0-9_-]{22})$/.exec(path);
    if (group && req.method === "PUT") {
      try { roster.set(group[1], JSON.parse(await read(req))); } catch { return send(res, 400, { error: "a JSON object of key → name" }); }
      return send(res, 204);
    }
    if (path === "/healthz") {
      const livekit = livekitHealth ? await fetch(livekitHealth, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false) : true;
      return send(res, livekit ? 200 : 503, { ok: livekit, origin });
    }
    if (path === "/smoke") return res.writeHead(200, { "content-type": "text/html" }).end(SMOKE);
    if (path === "/livekit-client.umd.js") {
      const file = await Promise.resolve().then(() => readFile(createRequire(import.meta.url).resolve("livekit-client"))).catch(() => null);
      return file ? res.writeHead(200, { "content-type": "text/javascript" }).end(file) : send(res, 404, { error: "livekit-client is not installed here" });
    }
    send(res, 404, { error: "not found" });
  });
  return new Promise((resolve) => server.listen(port, host, () => {
    resolve({ url: `http://${host}:${server.address().port}`, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) });
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const service = await startTokenService({
    port: Number(env.SFU_TOKEN_PORT || 7890), host: "0.0.0.0", origin: env.SFU_TOKEN_ORIGIN, livekitUrl: env.LIVEKIT_PUBLIC_URL,
    livekitHealth: env.LIVEKIT_HEALTH_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET, rosters: JSON.parse(env.SFU_TOKEN_ROSTERS || "{}"),
  });
  console.log(`group-token mock for ${env.SFU_TOKEN_ORIGIN} on ${service.url}, passes for ${env.LIVEKIT_PUBLIC_URL}`);
}

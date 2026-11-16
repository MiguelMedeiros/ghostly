// A mock of a Ghostly node's group-call token route (WISP 602), in front of the e2e stack's LiveKit server (--dev).
// It runs every check of WISP 602 § What the node checks, with a roster a test sets (PUT /test/roster/<g>) or the
// environment gives (SFU_TOKEN_ROSTERS), and answers with a LiveKit access token signed by the dev key. node:crypto
// only. It also serves a page with LiveKit's browser client (/smoke) for the stack's smoke spec, and for the group-call
// spec's outsider: someone with a pass but not the group's call key, joining sealed with a key of its own.
// It answers the group's admin (the roster's `admin`) on POST /sfu/group-moderate too: it keeps each room's mutes and
// bans in memory, acts on LiveKit through its RoomService (Twirp, with a roomAdmin token), and its passes honour them.
import { createRequire } from "node:module";
import { createHmac, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";
const B64URL = /^[A-Za-z0-9_-]+$/;
const LIMIT = 30, MINUTE = 60_000;

/**
 * A page that joins a room with a pass and publishes its camera; each remote camera plays in a <video data-identity>.
 * `joinSealed` joins with LiveKit's E2EE instead, the way the app does (the same livekit-client, its worker, a raw
 * 32-byte key as HKDF material), under a key of its own, and publishes nothing; `window.sealErrors` counts the frames
 * its worker could not open.
 */
const SMOKE = `<!doctype html><meta charset="utf-8"><title>SFU smoke</title><script src="/livekit-client.umd.js"></script>
<script>
window.joinSealed = async (url, token, key) => {
  const { Room, RoomEvent, Track, ExternalE2EEKeyProvider } = LivekitClient;
  const keyProvider = new ExternalE2EEKeyProvider();
  await keyProvider.setKey(Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer);
  const room = new Room({ adaptiveStream: false, encryption: { keyProvider, worker: new Worker("/livekit-client.e2ee.worker.js") } });
  window.sealErrors = 0;
  room.on(RoomEvent.EncryptionError, () => { window.sealErrors += 1; });
  room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (track.kind !== Track.Kind.Video) return;
    const video = track.attach();
    video.dataset.identity = participant.identity;
    document.body.append(video);
  });
  await room.setE2EEEnabled(true);
  window.room = room;
  await room.connect(url, token);
};
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

const ACTS = ["mute", "allow", "remove", "unban", "state"];
const SOURCES = ["camera", "microphone", "screen_share"];

/** The bytes an admin's key signs for a moderation request: another tag than a token request's, so one is never the other. */
export const moderateBytes = (sfuOrigin, { g, room, k, act, target, src, ts, n }) =>
  Buffer.from(JSON.stringify(["ghostly-sfu/1 moderate", sfuOrigin, g, room, k, act, target, src, ts, n]));

/** Whether `body` is a moderation request of the right shape whose `sig` verifies under `k` for `sfuOrigin`. */
export function verifyModeration(sfuOrigin, body) {
  const { v, g, k, room, act, target, src, ts, n, sig } = body ?? {};
  const sources = (act === "mute" || act === "allow")
    ? Array.isArray(src) && src.length > 0 && src.every((s, i) => SOURCES.includes(s) && (i === 0 || src[i - 1] < s))
    : Array.isArray(src) && src.length === 0;
  const aimed = act === "state" ? target === "" : target !== k && keyBytes(target) !== null;
  const shaped = v === 1 && typeof g === "string" && g.length === 22 && B64URL.test(g) && room === `g_${g}` && ACTS.includes(act) && sources && aimed
    && Number.isInteger(ts) && typeof n === "string" && n.length === 22 && B64URL.test(n) && typeof sig === "string" && sig.length === 86 && B64URL.test(sig);
  const key = shaped ? keyBytes(k) : null;
  if (!key) return false;
  const spki = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]), format: "der", type: "spki" });
  return verify(null, moderateBytes(sfuOrigin, body), spki, Buffer.from(sig, "base64url"));
}

/** The sources a key muted of `muted` may still publish (LiveKit's names); `screen_share` takes its audio along. */
const allowedSources = (muted = []) => [...SOURCES, "screen_share_audio"].filter((s) => !muted.includes(s) && !(s === "screen_share_audio" && muted.includes("screen_share")));

function jwt(apiSecret, payload) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}`;
  return `${unsigned}.${createHmac("sha256", apiSecret).update(unsigned).digest("base64url")}`;
}

/** A LiveKit access token (HS256) that joins `room` and no other; with `muted`, it publishes none of those sources. */
export function accessToken({ apiKey, apiSecret, room, identity, name, ttl, now, muted }) {
  const sources = muted?.length ? allowedSources(muted) : null;
  const publish = sources ? (sources.length ? { canPublish: true, canPublishSources: sources } : { canPublish: false }) : { canPublish: true };
  return jwt(apiSecret, { iss: apiKey, sub: identity, jti: identity, name, nbf: now, exp: now + ttl, video: { room, roomJoin: true, ...publish, canSubscribe: true, canPublishData: true } });
}

/** A roster as a test gives it: `{ members: { k: name }, admin: k }`, or the older plain `{ k: name }` with no admin. */
const asRoster = (body) => (body && typeof body === "object" && !Array.isArray(body)
  ? ("members" in body ? { members: body.members ?? {}, admin: body.admin } : { members: body, admin: undefined })
  : null);

/**
 * The service. `origin` is the https origin it answers for (what a group's `call.sfu` names), `livekitUrl` where the
 * clients' LiveKit SDK connects, `livekitApi` LiveKit's HTTP base for RoomService, `rosters` g → a roster (asRoster).
 * `now` is the clock, in milliseconds.
 */
export function startTokenService({ port = 0, host = "127.0.0.1", origin, livekitUrl, livekitHealth, livekitApi, apiKey = "devkey", apiSecret = "secret", rosters = {}, now = Date.now } = {}) {
  const roster = new Map(Object.entries(rosters).map(([g, body]) => [g, asRoster(body)]));
  /** room → { muted: k → sources, banned: keys }, in memory only. */
  const rooms = new Map();
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

  /** The body of a signed request past the limiter, its time and its nonce checked (checks 2 and 3), or null once answered. */
  async function signed(req, res, route, verified) {
    const text = await read(req);
    let body = null;
    try { body = text === null ? null : JSON.parse(text); } catch { /* refused below */ }
    const wait = limited(`${route}a:${req.socket.remoteAddress}`, typeof body?.k === "string" ? `${route}k:${body.k}` : null);
    if (wait) return send(res, 429, { error: "slow down" }, { "retry-after": String(wait) });
    const t = now();
    for (const [n, at] of nonces) if (t - at > 120_000) nonces.delete(n);
    // One refusal for every check, so a caller is not told which one failed.
    const ok = verified(body) && Math.abs(t / 1000 - body.ts) <= 60 && !nonces.has(body.n);
    return ok ? body : send(res, 403, { error: "refused" });
  }
  const stateOf = (name) => rooms.get(name) ?? rooms.set(name, { muted: new Map(), banned: new Set() }).get(name);

  async function token(req, res) {
    const body = await signed(req, res, "", (b) => verifyRequest(origin, b));
    if (!body) return;
    const { members } = roster.get(body.g) ?? {};
    const { muted, banned } = rooms.get(body.room) ?? { muted: new Map(), banned: new Set() };
    if (members?.[body.k] === undefined || banned.has(body.k)) return send(res, 403, { error: "refused" });
    nonces.set(body.n, now());
    const name = [...(members[body.k] || body.name || "")].slice(0, 64).join("");
    const expiresIn = 600;
    const pass = accessToken({ apiKey, apiSecret, room: body.room, identity: body.k, name, ttl: expiresIn, now: Math.floor(now() / 1000), muted: muted.get(body.k) });
    send(res, 200, { url: livekitUrl, token: pass, room: body.room, identity: body.k, expiresIn });
  }

  /** A LiveKit RoomService call (Twirp JSON) for `room`, as its admin: the reply, or null where LiveKit has no such participant. */
  async function roomService(method, room, request) {
    const t = Math.floor(now() / 1000);
    const admin = jwt(apiSecret, { iss: apiKey, nbf: t, exp: t + 60, video: { room, roomAdmin: true } });
    const res = await fetch(`${livekitApi}/twirp/livekit.RoomService/${method}`, {
      method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ room, ...request }), signal: AbortSignal.timeout(5000),
    });
    const reply = await res.json().catch(() => ({}));
    if (res.ok) return reply;
    if (reply.code === "not_found") return null;
    throw new Error(`LiveKit ${method}: ${res.status} ${reply.msg ?? ""}`);
  }
  /** What a muted member of `room` may publish now: its tracks of muted sources muted, then its permission cut. */
  async function permit(name, identity, muted = []) {
    const info = await roomService("GetParticipant", name, { identity });
    if (!info) return;
    const allowed = allowedSources(muted).map((s) => s.toUpperCase());
    for (const track of info.tracks ?? []) {
      const source = typeof track.source === "number" ? ["UNKNOWN", "CAMERA", "MICROPHONE", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"][track.source] : track.source;
      if (muted.length && !allowed.includes(source) && !track.muted) await roomService("MutePublishedTrack", name, { identity, track_sid: track.sid, muted: true });
    }
    // An empty list of sources is every source to LiveKit, so a member muted of all of them publishes nothing.
    const sources = muted.length ? allowed : [];
    const permission = { can_subscribe: true, can_publish: !muted.length || sources.length > 0, can_publish_data: true, can_publish_sources: sources };
    await roomService("UpdateParticipant", name, { identity, permission });
  }

  async function moderate(req, res) {
    const body = await signed(req, res, "m:", (b) => verifyModeration(origin, b));
    if (!body) return;
    if (roster.get(body.g)?.admin !== body.k) return send(res, 403, { error: "refused" });
    nonces.set(body.n, now());
    const { muted, banned } = stateOf(body.room);
    const { act, target, src } = body;
    try {
      if (act === "mute" || act === "allow") {
        const had = muted.get(target) ?? [];
        const next = act === "mute" ? [...new Set([...had, ...src])].sort() : had.filter((s) => !src.includes(s));
        if (next.length) muted.set(target, next);
        else muted.delete(target);
        await permit(body.room, target, next);
      }
      if (act === "remove") {
        banned.add(target);
        await roomService("RemoveParticipant", body.room, { identity: target });
      }
      if (act === "unban") banned.delete(target);
    } catch (error) {
      return send(res, 502, { error: String(error.message ?? error) });
    }
    send(res, 200, { state: { muted: Object.fromEntries([...muted].sort(([a], [b]) => (a < b ? -1 : 1))), banned: [...banned].sort() } });
  }

  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const signedRoute = path === "/sfu/group-token" || path === "/sfu/group-moderate";
    if (signedRoute && req.method === "OPTIONS") return send(res, 204, undefined, { "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "Content-Type" });
    if (path === "/sfu/group-token" && req.method === "POST") return token(req, res);
    if (path === "/sfu/group-moderate" && req.method === "POST") return moderate(req, res);
    const group = /^\/test\/roster\/([A-Za-z0-9_-]{22})$/.exec(path);
    if (group && req.method === "PUT") {
      let set = null;
      try { set = asRoster(JSON.parse(await read(req))); } catch { /* answered below */ }
      if (!set) return send(res, 400, { error: "a JSON object { members: { key: name }, admin: key }, or of key → name" });
      roster.set(group[1], set);
      return send(res, 204);
    }
    if (path === "/healthz") {
      const livekit = livekitHealth ? await fetch(livekitHealth, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false) : true;
      return send(res, livekit ? 200 : 503, { ok: livekit, origin });
    }
    if (path === "/smoke") return res.writeHead(200, { "content-type": "text/html" }).end(SMOKE);
    if (path === "/livekit-client.umd.js" || path === "/livekit-client.e2ee.worker.js") {
      const at = (umd) => (path === "/livekit-client.umd.js" ? umd : join(dirname(umd), "livekit-client.e2ee.worker.js"));
      const file = await Promise.resolve().then(() => readFile(at(createRequire(import.meta.url).resolve("livekit-client")))).catch(() => null);
      return file ? res.writeHead(200, { "content-type": "text/javascript" }).end(file) : send(res, 404, { error: "livekit-client is not installed here" });
    }
    send(res, 404, { error: "not found" });
  });
  // Idle keep-alive sockets stay open: a spec's route.fetch reuses its socket after a quiet stretch of a call, and one
  // closed after Node's 5 s could close just as that request went out (socket hang up through the stack's docker-proxy).
  server.keepAliveTimeout = 0;
  return new Promise((resolve) => server.listen(port, host, () => {
    resolve({ url: `http://${host}:${server.address().port}`, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) });
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const service = await startTokenService({
    port: Number(env.SFU_TOKEN_PORT || 7890), host: "0.0.0.0", origin: env.SFU_TOKEN_ORIGIN, livekitUrl: env.LIVEKIT_PUBLIC_URL,
    livekitHealth: env.LIVEKIT_HEALTH_URL, livekitApi: env.LIVEKIT_API_URL || env.LIVEKIT_HEALTH_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET, rosters: JSON.parse(env.SFU_TOKEN_ROSTERS || "{}"),
  });
  console.log(`group-token mock for ${env.SFU_TOKEN_ORIGIN} on ${service.url}, passes for ${env.LIVEKIT_PUBLIC_URL}`);
}

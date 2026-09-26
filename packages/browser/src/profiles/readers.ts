import { isAtprotoDid, isPubkyKey, normalizeAtprotoHandle } from "@ghostly/core";
import type { IdentityFetch } from "../proofs/contract";
import { assertPublicServer, resolveAtprotoDid } from "../proofs/atproto/resolve";
import { chosenResolver } from "../proofs/domain";
import { readRelays } from "../nostr/relay";
import { httpsUrl, KIND_FOLLOWS, KIND_PROFILE, MAX_PROFILE_CONTENT, newestOf, parseFollows, parseProfile, plainText } from "../nostr/social";
import { AVATAR_MAX_BYTES, decodeAvatar, fetchAvatar, PROFILE_AVATAR_SIDE, profileName, type AvatarResult } from "./public";

/**
 * Public profiles of verified identities (docs/wisps/PUBLIC-PROFILES.md): one reader per network that has a
 * public profile for the proven key, each asking only its fixed public host for exactly that key. What comes
 * back is self-described by the account, bounded and plain text; a picture is a small re-encoded JPEG data URL.
 */

export interface PublicProfileData {
  /** False when the network has no profile for this key (a normal answer, not a failure). */
  found: boolean;
  name?: string;
  /** How the network writes the account ("@alice.bsky.social", a Nostr `name`). */
  handle?: string;
  /** A short bio. */
  about?: string;
  /** The website the account names: an https address, no credentials. */
  website?: string;
  /** A sanitized `data:image/jpeg;base64,…` URL, never a remote one. */
  avatar?: string;
  /** When the profile names a picture that is not shown, which rule refused it ("it is a GIF; …"). Never the identity. */
  avatarMiss?: string;
  followers?: number;
  following?: number;
  /** The hosts that were asked, for the card's "Loaded from". */
  hosts: string[];
}

export interface ReaderContext {
  /** Bounded HTTPS GET (the engine's identity fetch): no credentials, no redirects, a size cap. */
  fetch: IdentityFetch;
  signal: AbortSignal;
  /** The Nostr relays in the person's settings. */
  relays: readonly string[];
  makeSocket?: (url: string) => WebSocket;
  /** Tests: where avatars are fetched from for the fixed Nostr hosts (the global fetch otherwise). */
  avatarFetch?: typeof fetch;
}

export interface PublicProfileReader {
  /** The network, for the Settings text. */
  network: string;
  /** Throws when the host could not be asked (the cached copy stays); `found: false` when it has no profile. */
  read(subject: string, ctx: ReaderContext): Promise<PublicProfileData>;
}

/** Longest JSON answer read from a profile host. */
export const PROFILE_JSON_MAX_BYTES = 16 * 1024;
/** Longest bio kept. */
export const PROFILE_ABOUT_MAX = 280;
/** Largest follower count believed: anything above is a broken answer, not a count. */
const MAX_COUNT = 1_000_000_000;

export const PUBKY_NEXUS = "https://nexus.pubky.app";
export const BLUESKY_APPVIEW = "https://public.api.bsky.app";
/** Bluesky's avatar CDN: the AppView names avatars there. It sends no CORS header, so the picture is read from the account's own server. */
const BLUESKY_CDN_AVATAR = /^https:\/\/cdn\.bsky\.app\/img\/avatar\/plain\/(did:[a-z]+:[A-Za-z0-9._:%-]+)\/(b[a-z2-7]{20,100})(@(jpeg|png))?$/;

const count = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COUNT ? value as number : undefined;
const hostOf = (url: string) => new URL(url).host;
const pictureUnreachable = (host: string): AvatarResult => ({ miss: `${host} could not be reached, or the picture is larger than ${AVATAR_MAX_BYTES / 1024 / 1024} MiB` });

function json(response: { status: number; text: string }): Record<string, unknown> | undefined {
  try {
    const data: unknown = JSON.parse(response.text);
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** Fields set only when present, so views and the cache never carry `undefined` keys. */
function profile(fields: Omit<PublicProfileData, "found" | "hosts">, hosts: string[]): PublicProfileData {
  const out: PublicProfileData = { found: true, hosts };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== "") (out as unknown as Record<string, unknown>)[k] = v;
  return out;
}

/**
 * Nostr: the newest signed kind-0 of exactly this key (signature, author, size and time checked by the relay
 * client), from the relays in the person's settings; following = the size of the newest kind-3 follow list.
 * Followers cannot be known without asking a counting service, so there are none.
 */
export const nostrReader: PublicProfileReader = {
  network: "Nostr",
  async read(subject, ctx) {
    if (!/^[a-f0-9]{64}$/.test(subject)) return { found: false, hosts: [] };
    const options = { makeSocket: ctx.makeSocket, signal: ctx.signal, timeoutMs: 5_000 };
    const [meta, follows] = await Promise.all([
      readRelays(ctx.relays, { kinds: [KIND_PROFILE], authors: [subject], limit: 3 }, { ...options, maxEvents: 20, maxFrameBytes: PROFILE_JSON_MAX_BYTES, maxContentLength: MAX_PROFILE_CONTENT }),
      // A follow list can be long; only its size is kept.
      readRelays(ctx.relays, { kinds: [KIND_FOLLOWS], authors: [subject], limit: 3 }, { ...options, maxEvents: 20, maxFrameBytes: 256 * 1024, maxContentLength: 64 * 1024 }).catch(() => undefined),
    ]);
    if (meta.answered.length === 0) throw new Error("No relay answered");
    const hosts = meta.answered.map(hostOf);
    const event = newestOf(meta.events, KIND_PROFILE, subject);
    const p = event ? parseProfile(event, subject) : undefined;
    const followsEvent = follows ? newestOf(follows.events, KIND_FOLLOWS, subject) : undefined;
    const following = followsEvent ? parseFollows(followsEvent, subject)?.follows.length : undefined;
    if (!p) return following === undefined ? { found: false, hosts } : profile({ following }, hosts);
    const picture = p.picture ? await fetchAvatar(p.picture, { fetcher: ctx.avatarFetch, side: PROFILE_AVATAR_SIDE, signal: ctx.signal }) : undefined;
    return profile({ name: p.name, handle: p.handle, about: plainText(p.about, PROFILE_ABOUT_MAX, true), website: p.website, avatar: picture?.avatar, avatarMiss: picture?.miss, following }, [...hosts, ...(picture?.hosts ?? [])]);
  },
};

/** The first https link a Pubky profile lists (`links: [{ title, url }]`). */
function pubkyWebsite(links: unknown): string | undefined {
  if (!Array.isArray(links)) return;
  for (const l of links.slice(0, 16)) { const url = httpsUrl((l as { url?: unknown } | null)?.url); if (url) return url; }
  return;
}

/**
 * Pubky: the Pubky index (nexus.pubky.app) for exactly this key: `details` (its `id` must be the key; a deleted
 * account has none), `counts` for followers and following, and the official avatar route when it reports an image.
 * This is indexed public metadata, not a response the key signed.
 */
export const pubkyReader: PublicProfileReader = {
  network: "Pubky",
  async read(subject, ctx) {
    if (!isPubkyKey(subject)) return { found: false, hosts: [] };
    const hosts = [hostOf(PUBKY_NEXUS)];
    const get = (path: string, maxBytes = PROFILE_JSON_MAX_BYTES) =>
      ctx.fetch(`${PUBKY_NEXUS}/v0/user/${subject}${path}`, { headers: { accept: "application/json" }, maxBytes, signal: ctx.signal });
    const details = await get("/details");
    if (details.status === 404) return { found: false, hosts };
    if (details.status !== 200) throw new Error(`The Pubky index answered ${details.status}`);
    const d = json(details);
    if (!d || d.id !== subject) throw new Error("The Pubky index answered for another key");
    if (d.deleted === true) return { found: false, hosts };
    const name = profileName(d.name);
    const [counts, picture] = await Promise.all([
      get("/counts").then(r => (r.status === 200 ? json(r) : undefined), () => undefined),
      // The index serves avatars as WebP (checked 2026-09-26), whatever the account uploaded.
      typeof d.image === "string" && d.image
        ? ctx.fetch(`${PUBKY_NEXUS}/static/avatar/${subject}`, { maxBytes: AVATAR_MAX_BYTES, signal: ctx.signal })
          .then(r => (r.status === 200 ? decodeAvatar(r.bytes, PROFILE_AVATAR_SIDE) : { miss: `${hosts[0]} answered ${r.status}` }), () => pictureUnreachable(hosts[0]))
        : undefined,
    ]);
    return profile({
      name: name === subject ? undefined : name,
      about: plainText(d.bio, PROFILE_ABOUT_MAX, true),
      website: pubkyWebsite(d.links),
      avatar: picture?.avatar,
      avatarMiss: picture?.miss,
      followers: count(counts?.followers),
      following: count(counts?.following),
    }, hosts);
  },
};

/**
 * Bluesky / AT Protocol: Bluesky's public AppView (`app.bsky.actor.getProfile`, no account needed) for exactly this
 * DID. The picture it names on cdn.bsky.app cannot be read by a page (no CORS header), so its blob is read from the
 * account's own server, the one its DID document names and the proof was checked against, after the same
 * public-address check verification makes.
 */
export const atprotoReader: PublicProfileReader = {
  network: "Bluesky",
  async read(subject, ctx) {
    if (!isAtprotoDid(subject)) return { found: false, hosts: [] };
    const hosts = [hostOf(BLUESKY_APPVIEW)];
    const response = await ctx.fetch(`${BLUESKY_APPVIEW}/xrpc/app.bsky.actor.getProfile?${new URLSearchParams({ actor: subject })}`,
      { headers: { accept: "application/json" }, maxBytes: PROFILE_JSON_MAX_BYTES, signal: ctx.signal });
    const d = json(response);
    if (response.status === 400 && /^(InvalidRequest|AccountTakedown|AccountDeactivated|NotFound)$/.test(String(d?.error ?? ""))) return { found: false, hosts };
    if (response.status !== 200) throw new Error(`Bluesky answered ${response.status}`);
    if (!d || d.did !== subject) throw new Error("Bluesky answered for another account");
    const handle = typeof d.handle === "string" && d.handle !== "handle.invalid" ? normalizeAtprotoHandle(d.handle) : null;
    let picture: AvatarResult | undefined;
    const cdn = typeof d.avatar === "string" ? BLUESKY_CDN_AVATAR.exec(d.avatar) : null;
    if (cdn && cdn[1] === subject) {
      try {
        const resolve = { fetch: ctx.fetch, signal: ctx.signal, resolver: chosenResolver().id };
        const doc = await resolveAtprotoDid(subject, resolve);
        const server = new URL(doc.pds);
        await assertPublicServer(server.hostname, resolve);
        const blob = await ctx.fetch(`${doc.pds}/xrpc/com.atproto.sync.getBlob?${new URLSearchParams({ did: subject, cid: cdn[2] })}`, { maxBytes: AVATAR_MAX_BYTES, signal: ctx.signal });
        picture = blob.status === 200 ? await decodeAvatar(blob.bytes, PROFILE_AVATAR_SIDE) : { miss: `${server.host} answered ${blob.status}` };
        hosts.push(server.host);
      } catch { picture = { miss: "the account's server could not be asked for it" }; /* the name and counts still show; the picture falls back to the mark */ }
    } else if (typeof d.avatar === "string") picture = { miss: "Bluesky named it at an address this app does not read" };
    return profile({
      name: profileName(d.displayName),
      handle: handle ? `@${handle}` : undefined,
      about: plainText(d.description, PROFILE_ABOUT_MAX, true),
      website: httpsUrl(d.website),
      avatar: picture?.avatar,
      avatarMiss: picture?.miss,
      followers: count(d.followersCount),
      following: count(d.followsCount),
    }, hosts);
  },
};

/** Providers whose verified identities have a public profile, by provider id. Nothing else is ever looked up. */
export const PUBLIC_PROFILE_READERS: Readonly<Record<string, PublicProfileReader>> = {
  nostr: nostrReader,
  pubky: pubkyReader,
  atproto: atprotoReader,
};

export const hasPublicProfile = (provider: string) => Object.prototype.hasOwnProperty.call(PUBLIC_PROFILE_READERS, provider);

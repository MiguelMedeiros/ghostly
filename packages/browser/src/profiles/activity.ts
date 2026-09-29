import { noteEncode, npubEncode } from "nostr-tools/nip19";
import { isAtprotoDid, isPubkyKey } from "@ghostly/core";
import { assertPublicServer, resolveAtprotoDid } from "../proofs/atproto/resolve";
import { chosenResolver } from "../proofs/domain";
import { readRelays } from "../nostr/relay";
import { KIND_FOLLOWS, KIND_NOTE, newestOf, parseFollows, parseNote, plainText, type NostrNote } from "../nostr/social";
import { AVATAR_MAX_BYTES, avatarSource, decodeFitted, fetchAvatar, POST_IMAGE_SIDE, type AvatarResult } from "./public";
import { BLUESKY_APPVIEW, PUBKY_NEXUS, type ReaderContext } from "./readers";

/**
 * What a verified identity published, beyond its profile (docs/wisps/PUBLIC-PROFILES.md, "Posts and follows"): its
 * recent posts and whom it follows (and, where the network lists them, who follows it), read from the same fixed hosts
 * as its profile, for exactly the proven key. Posts are plain text, bounded; a post's pictures are only named here and
 * fetched on the reader's tap (`readPostImage`). Follow lists are kept only to find people the reader already knows.
 */

/** Posts per page. */
export const POSTS_PAGE = 10;
/** Longest post text kept, in UTF-16 code units. */
export const POST_TEXT_MAX = 2_000;
/** Pictures named per post. */
export const POST_IMAGES_MAX = 4;
/** Longest alt text kept. */
const ALT_MAX = 300;
/** Largest JSON page of posts or of a follow list. */
export const ACTIVITY_JSON_MAX_BYTES = 512 * 1024;
/** Most entries read from one follow list (following, or followers): past it, the list is partial. */
export const GRAPH_MAX = 1_000;
/** A post dated later than now plus this is shown as posted now: the author chose the date. */
const FUTURE_SLACK_SECONDS = 5 * 60;

/** Where a post's picture is read from, when the reader taps it. Kept by the engine; the page only sees the host. */
export type PostImageSource =
  /** A picture link in a Nostr note, on one of the fixed picture hosts. */
  | { kind: "url"; url: string }
  /** A Pubky file, as the index serves it (a WebP of the "feed" size). */
  | { kind: "nexus"; owner: string; file: string }
  /** A Bluesky blob, read from the account's own server (cdn.bsky.app cannot be read by a page). */
  | { kind: "atproto-blob"; did: string; cid: string };

/** `host`: who is asked for it; absent for a Bluesky blob, whose server is known once the DID is resolved. */
export interface PublicPostImage { source: PostImageSource; host?: string; alt?: string }

export interface PublicPost {
  id: string;
  /** Seconds. */
  createdAt: number;
  text: string;
  /** Where the post opens in its network's app or site. */
  url?: string;
  /** An answer to another post. */
  reply?: boolean;
  images: PublicPostImage[];
  /** Nostr: keys the note mentions, for the reader's mute list. */
  mentions?: string[];
}

export interface PublicPostsPage {
  posts: PublicPost[];
  /** Where the next page starts; absent when there is none. */
  cursor?: string;
  hosts: string[];
}

export interface PublicGraph {
  /** Keys (or DIDs) this identity follows, as far as read. */
  following: string[];
  followingComplete: boolean;
  /** Who follows it, where the network lists them (never for Nostr). */
  followers?: string[];
  followersComplete?: boolean;
  hosts: string[];
}

export interface ActivityReader {
  /** One page of the identity's own recent posts (no reposts), newest first. */
  posts(subject: string, ctx: ReaderContext, cursor?: string): Promise<PublicPostsPage>;
  /** Its follow lists, bounded. */
  graph(subject: string, ctx: ReaderContext): Promise<PublicGraph>;
  /** Where its profile opens in its network's app or site. */
  profileUrl(subject: string): string | undefined;
}

const hostOf = (url: string) => new URL(url).host;
const nowSeconds = () => Math.floor(Date.now() / 1000);
/** A time an author chose: never in the future, never negative. */
const clampTime = (seconds: number) => Math.max(0, Math.min(Math.floor(seconds), nowSeconds() + FUTURE_SLACK_SECONDS));

/** A post's text: plain, controls and bidi overrides removed, capped (an ellipsis says it was cut). */
export function postText(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const text = plainText(value.length > 64 * 1024 ? value.slice(0, 64 * 1024) : value, POST_TEXT_MAX + 1, true);
  if (!text) return;
  return text.length > POST_TEXT_MAX ? `${text.slice(0, POST_TEXT_MAX - 1)}…` : text;
}

function json(response: { status: number; text: string }): unknown {
  try { return JSON.parse(response.text); } catch { return undefined; }
}
const record = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined);

// -- Nostr ------------------------------------------------------------------------------------------

/** Picture links in a note's text that are on the fixed picture hosts; any other host stays a plain link. */
const IMAGE_LINK = /https:\/\/[^\s<>"'()]{1,2000}?\.(?:jpe?g|png|webp)(?:\?[^\s<>"'()]{0,200})?(?=$|[\s<>"'()])/gi;
export function noteImages(content: string): PublicPostImage[] {
  const out: PublicPostImage[] = [];
  for (const m of content.matchAll(IMAGE_LINK)) {
    const source = avatarSource(m[0]);
    if ("miss" in source || out.some(i => i.source.kind === "url" && i.source.url === source.url)) continue;
    out.push({ source: { kind: "url", url: source.url }, host: source.host });
    if (out.length >= POST_IMAGES_MAX) break;
  }
  return out;
}

export function nostrPostUrl(id: string): string | undefined { try { return `https://njump.me/${noteEncode(id)}`; } catch { return; } }

export function nostrPost(note: NostrNote): PublicPost {
  const text = postText(note.content) ?? "";
  return { id: note.id, createdAt: clampTime(note.createdAt), text, url: nostrPostUrl(note.id), ...(note.reply ? { reply: true } : {}), images: noteImages(note.content), mentions: note.mentions };
}

/**
 * Nostr: kind-1 notes and the kind-3 follow list of exactly the proven key, from the relays in the person's settings
 * (never relays named in events, hints or NIP-65 lists: docs/wisps/3xx-nostr-social.md). Replies are left out; a page
 * reads twice as many notes to find ten that are not. Followers cannot be listed without trusting a counting service.
 */
export const nostrActivity: ActivityReader = {
  async posts(subject, ctx, cursor) {
    if (!/^[a-f0-9]{64}$/.test(subject)) return { posts: [], hosts: [] };
    const until = cursor !== undefined && /^\d{1,12}$/.test(cursor) ? Number(cursor) : undefined;
    const filter = { kinds: [KIND_NOTE], authors: [subject], limit: POSTS_PAGE * 2, ...(until !== undefined ? { until } : {}) };
    const result = await readRelays(ctx.relays, filter, { makeSocket: ctx.makeSocket, signal: ctx.signal, timeoutMs: 6_000, maxEvents: POSTS_PAGE * 2, maxFrameBytes: 64 * 1024, maxContentLength: 16 * 1024 });
    if (result.answered.length === 0) throw new Error("No relay answered");
    const notes = result.events.map(e => parseNote(e, subject)).filter((n): n is NostrNote => !!n);
    const own = notes.filter(n => !n.reply);
    const posts = own.slice(0, POSTS_PAGE).map(nostrPost);
    // The next page starts at the last note shown (`until` includes it; the engine drops what it already has), or past
    // everything read when fewer than a page were the person's own. A relay that held fewer than asked has no more.
    const full = result.events.length >= POSTS_PAGE * 2 || own.length > POSTS_PAGE;
    const oldest = result.events.length ? Math.min(...result.events.map(e => e.created_at)) : 0;
    let next = own.length > POSTS_PAGE ? own[POSTS_PAGE - 1].createdAt : oldest - 1;
    if (until !== undefined && next >= until) next = until - 1;
    return { posts, ...(full && next > 0 ? { cursor: String(next) } : {}), hosts: result.answered.map(hostOf) };
  },
  async graph(subject, ctx) {
    if (!/^[a-f0-9]{64}$/.test(subject)) return { following: [], followingComplete: true, hosts: [] };
    const result = await readRelays(ctx.relays, { kinds: [KIND_FOLLOWS], authors: [subject], limit: 3 }, { makeSocket: ctx.makeSocket, signal: ctx.signal, timeoutMs: 6_000, maxEvents: 20, maxFrameBytes: 256 * 1024, maxContentLength: 64 * 1024 });
    if (result.answered.length === 0) throw new Error("No relay answered");
    const event = newestOf(result.events, KIND_FOLLOWS, subject);
    const follows = event ? parseFollows(event, subject)?.follows ?? [] : [];
    return { following: follows.slice(0, GRAPH_MAX), followingComplete: follows.length < GRAPH_MAX, hosts: result.answered.map(hostOf) };
  },
  profileUrl(subject) { try { return `https://njump.me/${npubEncode(subject)}`; } catch { return; } },
};

// -- Pubky ------------------------------------------------------------------------------------------

const PUBKY_POST_ID = /^[0-9A-Z]{8,32}$/;
const PUBKY_FILE = /^pubky:\/\/([a-z0-9]{52})\/pub\/pubky\.app\/files\/([0-9A-Z]{8,32})$/;
/** Nexus answers a skip up to 10,000. */
const PUBKY_SKIP_MAX = 10_000;
const PUBKY_GRAPH_PAGE = 200;

export const pubkyPostUrl = (author: string, id: string) => `https://pubky.app/post/${author}/${id}`;

/** One entry of nexus's post stream, for exactly `subject`; undefined for anything else. */
export function pubkyPost(value: unknown, subject: string): PublicPost | undefined {
  const v = record(value), d = record(v?.details);
  if (!d || d.author !== subject || typeof d.id !== "string" || !PUBKY_POST_ID.test(d.id)) return;
  const rel = record(v?.relationships);
  // A repost with no words of its own is someone else's post.
  if (rel?.reposted && !d.content) return;
  const at = typeof d.indexed_at === "number" && Number.isFinite(d.indexed_at) ? d.indexed_at / 1000 : 0;
  const images: PublicPostImage[] = [];
  const meta = Array.isArray(v?.attachments_metadata) ? v.attachments_metadata.slice(0, 16).map(record) : [];
  const attachments = Array.isArray(d.attachments) ? d.attachments.slice(0, 16) : [];
  for (const uri of attachments) {
    const m = typeof uri === "string" ? PUBKY_FILE.exec(uri) : null;
    if (!m || m[1] !== subject) continue;
    const info = meta.find(x => x?.uri === uri);
    // Only files the index says are pictures (without metadata, a post of kind "image").
    if (info ? !(typeof info.content_type === "string" && /^image\/(png|jpeg|webp)$/.test(info.content_type)) : d.kind !== "image") continue;
    const alt = plainText(info?.name, ALT_MAX);
    images.push({ source: { kind: "nexus", owner: m[1], file: m[2] }, host: hostOf(PUBKY_NEXUS), ...(alt ? { alt } : {}) });
    if (images.length >= POST_IMAGES_MAX) break;
  }
  const text = postText(d.content) ?? "";
  if (!text && !images.length) return;
  return { id: d.id, createdAt: clampTime(at), text, url: pubkyPostUrl(subject, d.id), ...(rel?.replied ? { reply: true } : {}), images };
}

function pubkyKeys(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((k): k is string => typeof k === "string" && isPubkyKey(k)) : undefined;
}

/**
 * Pubky: the index (nexus.pubky.app) for exactly this key: its posts stream (`/v0/stream/posts?source=author`),
 * its following and followers lists (`/v0/user/{id}/following`, `/followers`). Indexed public data, not signed
 * answers. No viewer is named in any request.
 */
export const pubkyActivity: ActivityReader = {
  async posts(subject, ctx, cursor) {
    if (!isPubkyKey(subject)) return { posts: [], hosts: [] };
    const skip = cursor !== undefined && /^\d{1,5}$/.test(cursor) ? Math.min(Number(cursor), PUBKY_SKIP_MAX) : 0;
    const query = new URLSearchParams({ source: "author", author_id: subject, limit: String(POSTS_PAGE), skip: String(skip), include_attachment_metadata: "true" });
    const r = await ctx.fetch(`${PUBKY_NEXUS}/v0/stream/posts?${query}`, { headers: { accept: "application/json" }, maxBytes: ACTIVITY_JSON_MAX_BYTES, signal: ctx.signal });
    const hosts = [hostOf(PUBKY_NEXUS)];
    if (r.status === 404) return { posts: [], hosts };
    if (r.status !== 200) throw new Error(`The Pubky index answered ${r.status}`);
    const list = json(r);
    if (!Array.isArray(list)) throw new Error("The Pubky index answered something else");
    const page = list.slice(0, POSTS_PAGE);
    const posts = page.map(p => pubkyPost(p, subject)).filter((p): p is PublicPost => !!p);
    const next = skip + page.length;
    return { posts, ...(page.length >= POSTS_PAGE && next < PUBKY_SKIP_MAX ? { cursor: String(next) } : {}), hosts };
  },
  async graph(subject, ctx) {
    if (!isPubkyKey(subject)) return { following: [], followingComplete: true, hosts: [] };
    const list = async (which: "following" | "followers") => {
      const out: string[] = [];
      for (let skip = 0; skip < GRAPH_MAX; skip += PUBKY_GRAPH_PAGE) {
        const r = await ctx.fetch(`${PUBKY_NEXUS}/v0/user/${subject}/${which}?skip=${skip}&limit=${PUBKY_GRAPH_PAGE}`, { headers: { accept: "application/json" }, maxBytes: 64 * 1024, signal: ctx.signal });
        if (r.status === 404) return { keys: out, complete: true };
        if (r.status !== 200) throw new Error(`The Pubky index answered ${r.status}`);
        const keys = pubkyKeys(json(r));
        if (!keys) throw new Error("The Pubky index answered something else");
        out.push(...keys.slice(0, PUBKY_GRAPH_PAGE));
        if (keys.length < PUBKY_GRAPH_PAGE) return { keys: [...new Set(out)], complete: true };
      }
      return { keys: [...new Set(out)].slice(0, GRAPH_MAX), complete: false };
    };
    const [following, followers] = await Promise.all([list("following"), list("followers")]);
    return { following: following.keys, followingComplete: following.complete, followers: followers.keys, followersComplete: followers.complete, hosts: [hostOf(PUBKY_NEXUS)] };
  },
  profileUrl: subject => (isPubkyKey(subject) ? `https://pubky.app/profile/${subject}` : undefined),
};

// -- Bluesky ----------------------------------------------------------------------------------------

const AT_POST = /^at:\/\/(did:[a-z]+:[A-Za-z0-9._:%-]{1,256})\/app\.bsky\.feed\.post\/([A-Za-z0-9._:~-]{1,512})$/;
const CID = /^b[a-z2-7]{20,100}$/;
const BSKY_GRAPH_PAGE = 100;

export const blueskyPostUrl = (did: string, rkey: string) => `https://bsky.app/profile/${did}/post/${rkey}`;

/** Bluesky shortens links in a post's text ("example.com/abc…"); its link facets hold the full address. */
export function expandLinkFacets(text: string, facets: unknown): string {
  if (!Array.isArray(facets) || facets.length > 100 || text.length > 10_000) return text;
  const bytes = new TextEncoder().encode(text);
  const links: { start: number; end: number; uri: string }[] = [];
  for (const f of facets) {
    const index = record(record(f)?.index);
    const feature = (Array.isArray(record(f)?.features) ? (record(f)!.features as unknown[]) : []).map(record).find(x => x?.$type === "app.bsky.richtext.facet#link");
    const start = index?.byteStart, end = index?.byteEnd, uri = feature?.uri;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || typeof uri !== "string" || uri.length > 2048) continue;
    if ((start as number) < 0 || (end as number) > bytes.length || (start as number) >= (end as number)) continue;
    // A range that starts or ends inside a character would cut it in half.
    const inside = (i: number) => i < bytes.length && (bytes[i] & 0xc0) === 0x80;
    if (inside(start as number) || inside(end as number)) continue;
    try { if (new URL(uri).protocol !== "https:") continue; } catch { continue; }
    links.push({ start: start as number, end: end as number, uri });
  }
  links.sort((a, b) => a.start - b.start);
  const decoder = new TextDecoder();
  let out = "", at = 0;
  for (const l of links) {
    if (l.start < at) continue; // overlapping facets: the first one wins
    out += decoder.decode(bytes.subarray(at, l.start)) + l.uri;
    at = l.end;
  }
  return out + decoder.decode(bytes.subarray(at));
}

/** One feed item of `app.bsky.feed.getAuthorFeed`, the account's own post only (no repost, no one else's). */
export function blueskyPost(item: unknown, subject: string): PublicPost | undefined {
  const it = record(item);
  if (!it || it.reason) return;
  const post = record(it.post), rec = record(post?.record), author = record(post?.author);
  const m = typeof post?.uri === "string" ? AT_POST.exec(post.uri) : null;
  if (!post || !rec || !m || m[1] !== subject || author?.did !== subject) return;
  const text = postText(typeof rec.text === "string" ? expandLinkFacets(rec.text, rec.facets) : undefined) ?? "";
  const created = typeof rec.createdAt === "string" ? Date.parse(rec.createdAt) / 1000 : NaN;
  const indexed = typeof post.indexedAt === "string" ? Date.parse(post.indexedAt) / 1000 : NaN;
  const at = Number.isFinite(created) ? created : Number.isFinite(indexed) ? indexed : 0;
  // Pictures: the record's own blobs (plain images, or the media part of a quote with media).
  const embed = record(rec.embed);
  const media = embed?.$type === "app.bsky.embed.recordWithMedia" ? record(embed.media) : embed;
  const images: PublicPostImage[] = [];
  if (media?.$type === "app.bsky.embed.images" && Array.isArray(media.images)) {
    for (const img of media.images.slice(0, POST_IMAGES_MAX)) {
      const blob = record(record(img)?.image), cid = record(blob?.ref)?.$link;
      if (typeof cid !== "string" || !CID.test(cid) || !/^image\/(png|jpeg|webp)$/.test(String(blob?.mimeType))) continue;
      const alt = plainText(record(img)?.alt, ALT_MAX);
      images.push({ source: { kind: "atproto-blob", did: subject, cid }, ...(alt ? { alt } : {}) });
    }
  }
  if (!text && !images.length) return;
  return { id: m[2], createdAt: clampTime(at), text, url: blueskyPostUrl(subject, m[2]), ...(rec.reply ? { reply: true } : {}), images };
}

/**
 * Bluesky / AT Protocol: Bluesky's public AppView, no account needed, for exactly this DID: its own posts
 * (`app.bsky.feed.getAuthorFeed`, `posts_no_replies`, reposts left out), whom it follows and who follows it
 * (`app.bsky.graph.getFollows`, `getFollowers`). Its pictures are blobs on the account's own server, read on a tap.
 */
export const atprotoActivity: ActivityReader = {
  async posts(subject, ctx, cursor) {
    if (!isAtprotoDid(subject)) return { posts: [], hosts: [] };
    const query = new URLSearchParams({ actor: subject, limit: String(POSTS_PAGE), filter: "posts_no_replies" });
    if (cursor && cursor.length <= 256 && /^[\x21-\x7e]+$/.test(cursor)) query.set("cursor", cursor);
    const r = await ctx.fetch(`${BLUESKY_APPVIEW}/xrpc/app.bsky.feed.getAuthorFeed?${query}`, { headers: { accept: "application/json" }, maxBytes: ACTIVITY_JSON_MAX_BYTES, signal: ctx.signal });
    const d = record(json(r));
    const hosts = [hostOf(BLUESKY_APPVIEW)];
    if (r.status === 400 && /^(InvalidRequest|AccountTakedown|AccountDeactivated|NotFound|BlockedActor|BlockedByActor)$/.test(String(d?.error ?? ""))) return { posts: [], hosts };
    if (r.status !== 200 || !d || !Array.isArray(d.feed)) throw new Error(`Bluesky answered ${r.status}`);
    const posts = d.feed.slice(0, POSTS_PAGE * 2).map(i => blueskyPost(i, subject)).filter((p): p is PublicPost => !!p).slice(0, POSTS_PAGE);
    const next = typeof d.cursor === "string" && d.cursor.length <= 256 && d.feed.length > 0 ? d.cursor : undefined;
    return { posts, ...(next ? { cursor: next } : {}), hosts };
  },
  async graph(subject, ctx) {
    if (!isAtprotoDid(subject)) return { following: [], followingComplete: true, hosts: [] };
    const list = async (method: "getFollows" | "getFollowers", field: "follows" | "followers") => {
      const out: string[] = [];
      let cursor: string | undefined;
      while (out.length < GRAPH_MAX) {
        const query = new URLSearchParams({ actor: subject, limit: String(BSKY_GRAPH_PAGE) });
        if (cursor) query.set("cursor", cursor);
        const r = await ctx.fetch(`${BLUESKY_APPVIEW}/xrpc/app.bsky.graph.${method}?${query}`, { headers: { accept: "application/json" }, maxBytes: ACTIVITY_JSON_MAX_BYTES, signal: ctx.signal });
        const d = record(json(r));
        if (r.status === 400) return { dids: out, complete: true };
        if (r.status !== 200 || !d || !Array.isArray(d[field])) throw new Error(`Bluesky answered ${r.status}`);
        const page = (d[field] as unknown[]).slice(0, BSKY_GRAPH_PAGE);
        for (const p of page) { const did = record(p)?.did; if (typeof did === "string" && isAtprotoDid(did)) out.push(did); }
        cursor = typeof d.cursor === "string" && d.cursor.length <= 256 ? d.cursor : undefined;
        if (!cursor || page.length === 0) return { dids: [...new Set(out)], complete: true };
      }
      return { dids: [...new Set(out)].slice(0, GRAPH_MAX), complete: false };
    };
    const [following, followers] = await Promise.all([list("getFollows", "follows"), list("getFollowers", "followers")]);
    return { following: following.dids, followingComplete: following.complete, followers: followers.dids, followersComplete: followers.complete, hosts: [hostOf(BLUESKY_APPVIEW)] };
  },
  profileUrl: subject => (isAtprotoDid(subject) ? `https://bsky.app/profile/${subject}` : undefined),
};

/** Providers whose identities have posts and follows to show, by provider id. Nothing else is ever looked up. */
export const ACTIVITY_READERS: Readonly<Record<string, ActivityReader>> = {
  nostr: nostrActivity,
  pubky: pubkyActivity,
  atproto: atprotoActivity,
};
export const hasActivity = (provider: string) => Object.prototype.hasOwnProperty.call(ACTIVITY_READERS, provider);

/**
 * A post's picture, on the reader's tap: from the fixed picture hosts (Nostr), the Pubky index, or the Bluesky
 * account's own server after the same public-address check its avatar gets. Re-encoded to a JPEG `data:` URL.
 */
export async function readPostImage(source: PostImageSource, ctx: ReaderContext): Promise<AvatarResult & { hosts: string[] }> {
  if (source.kind === "url") return fetchAvatar(source.url, { fetcher: ctx.avatarFetch, signal: ctx.signal, decode: bytes => decodeFitted(bytes, POST_IMAGE_SIDE) });
  if (source.kind === "nexus") {
    const host = hostOf(PUBKY_NEXUS);
    const r = await ctx.fetch(`${PUBKY_NEXUS}/static/files/${source.owner}/${source.file}/feed`, { maxBytes: AVATAR_MAX_BYTES, signal: ctx.signal }).catch(() => undefined);
    if (!r) return { miss: `${host} could not be reached, or the picture is larger than ${AVATAR_MAX_BYTES / 1024 / 1024} MiB`, hosts: [host] };
    if (r.status !== 200) return { miss: `${host} answered ${r.status}`, hosts: [host] };
    return { ...(await decodeFitted(r.bytes)), hosts: [host] };
  }
  const resolve = { fetch: ctx.fetch, signal: ctx.signal, resolver: chosenResolver().id };
  let server: URL;
  try {
    const doc = await resolveAtprotoDid(source.did, resolve);
    server = new URL(doc.pds);
    await assertPublicServer(server.hostname, resolve);
  } catch { return { miss: "the account's server could not be asked for it", hosts: [] }; }
  const r = await ctx.fetch(`${server.origin}/xrpc/com.atproto.sync.getBlob?${new URLSearchParams({ did: source.did, cid: source.cid })}`, { maxBytes: AVATAR_MAX_BYTES, signal: ctx.signal }).catch(() => undefined);
  if (!r) return { miss: `${server.host} could not be reached, or the picture is larger than ${AVATAR_MAX_BYTES / 1024 / 1024} MiB`, hosts: [server.host] };
  if (r.status !== 200) return { miss: `${server.host} answered ${r.status}`, hosts: [server.host] };
  return { ...(await decodeFitted(r.bytes)), hosts: [server.host] };
}

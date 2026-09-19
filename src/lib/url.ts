import type { SessionKeys } from "./storage";

const SEPARATOR = "/";

/**
 * Where a chat lives in the app: by the id of its stored session. The keys
 * stay in storage; an address ends up in the history, and with Chrome Sync on
 * other machines, so it must not carry them.
 */
export function chatPath(sessionId: string): string {
  return `/chat/${encodeURIComponent(sessionId)}`;
}

/** `<seed>/<peer public key>/<encryption key>` */
function parseKeys(code: string): SessionKeys | null {
  const parts = code.replace(/^\/+/, "").replace(/\/+$/, "").split(SEPARATOR);
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_\-+=]+$/.test(part))) return null;
  const [seedB64, peerPubKeyB64, encKeyB64] = parts;
  return { seedB64, peerPubKeyB64, encKeyB64 };
}

/**
 * The keys in a route that carries them: an invite link opened in the app, or
 * a chat address from before chats were routed by session id.
 */
export function parseChatRoute(pathname: string): SessionKeys | null {
  const match = pathname.match(/^\/chat\/(.+)$/);
  return match ? parseKeys(match[1]) : null;
}

/** What someone may paste to join: an invite link, a `/chat/…` path or the bare invite code. */
export function parseInvite(input: string): SessionKeys | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const hash = new URL(trimmed).hash.replace(/^#/, "");
    if (hash.startsWith("/chat/")) return parseChatRoute(hash);
  } catch {
    // not a URL
  }
  const idx = trimmed.indexOf("/chat/");
  if (idx !== -1) return parseChatRoute(trimmed.slice(idx));
  return parseKeys(trimmed);
}

export function buildInviteCode(
  seedB: string,
  pubKeyA: string,
  encKey: string,
): string {
  return `${seedB}/${pubKeyA}/${encKey}`;
}

/** A link for the other person: opening it joins the chat, and the app takes the keys out of the address at once. */
export function buildInviteUrl(
  origin: string,
  seedB: string,
  pubKeyA: string,
  encKey: string,
): string {
  return `${origin}/#/chat/${seedB}/${pubKeyA}/${encKey}`;
}

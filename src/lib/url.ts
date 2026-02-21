import type { ChatParams } from "./types";

const SEPARATOR = "/";

export function encodeChatParams(params: ChatParams): string {
  return `${params.seedB64}${SEPARATOR}${params.peerPubKeyB64}${SEPARATOR}${params.encKeyB64}`;
}

export function decodeChatParams(fragment: string): ChatParams | null {
  const clean = fragment.replace(/^#?\/?chat\//, "");
  const parts = clean.split(SEPARATOR);
  if (parts.length !== 3) return null;
  const [seedB64, peerPubKeyB64, encKeyB64] = parts;
  if (!seedB64 || !peerPubKeyB64 || !encKeyB64) return null;
  return { seedB64, peerPubKeyB64, encKeyB64 };
}

export function buildCreatorUrl(
  origin: string,
  seedA: string,
  pubKeyB: string,
  encKey: string,
): string {
  return `${origin}/#/chat/${seedA}/${pubKeyB}/${encKey}`;
}

export function buildInviteUrl(
  origin: string,
  seedB: string,
  pubKeyA: string,
  encKey: string,
): string {
  return `${origin}/#/chat/${seedB}/${pubKeyA}/${encKey}`;
}

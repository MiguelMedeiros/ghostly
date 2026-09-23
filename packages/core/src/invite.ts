import { generateEncryptionKey } from "./crypto";
import { createIdentity } from "./identity";
import { toBase64Url } from "./bytes";

/**
 * A link between two peers: my identity, the peer's public key and the shared
 * secretbox key. This is the invite format Ghostly Desktop already uses
 * (`<seed>/<peer public key>/<encryption key>`), unchanged.
 */
export interface LinkParams {
  profile?: "paired-chat/1";
  deliveryMode?: "stream" | "dht";
  seedB64: string;
  peerPubKeyZ32: string;
  encKeyB64: string;
}

export function encodeInviteCode(params: LinkParams): string {
  return `${params.profile ? (params.deliveryMode === "dht" ? "pair2d/" : "pair1/") : ""}${params.seedB64}/${params.peerPubKeyZ32}/${params.encKeyB64}`;
}

export function decodeInviteCode(input: string): LinkParams | null {
  const clean = input
    .trim()
    .replace(/^.*#/, "")
    .replace(/^\/?chat\//, "");
  const dht = clean.startsWith("pair2d/");
  const profile = (dht || clean.startsWith("pair1/")) ? "paired-chat/1" as const : undefined;
  const parts = (profile ? clean.slice(dht ? 7 : 6) : clean).split("/");
  if (parts.length !== 3) return null;
  const [seedB64, peerPubKeyZ32, encKeyB64] = parts;
  if (!/^[A-Za-z0-9_-]{43}$/.test(seedB64)) return null;
  if (!/^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/.test(peerPubKeyZ32)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(encKeyB64)) return null;
  return { seedB64, peerPubKeyZ32, encKeyB64, ...(profile ? { profile, ...(dht ? { deliveryMode: "dht" as const } : {}) } : {}) };
}

/** Creates both ends of a link: keep `mine`, hand `invite` to the peer. */
export function createLink(): { mine: LinkParams; invite: LinkParams } {
  const a = createIdentity();
  const b = createIdentity();
  const encKeyB64 = toBase64Url(generateEncryptionKey());
  return {
    mine: { seedB64: a.seedB64, peerPubKeyZ32: b.pubKeyZ32, encKeyB64 },
    invite: { seedB64: b.seedB64, peerPubKeyZ32: a.pubKeyZ32, encKeyB64 },
  };
}

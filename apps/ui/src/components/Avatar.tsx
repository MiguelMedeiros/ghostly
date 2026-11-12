import { usePeerAvatar } from "../hooks/useAvatars";
import { initial } from "../lib/initial";
import { PeerPresenceDot } from "./PresenceMarks";

/**
 * A round picture, or the name's initial when there is none. `src` is a checked data URL (ours, or one
 * `sanitizeAvatar` accepted from a contact), never an address that would be fetched.
 */
export function Avatar({ src, label, testId }: { src?: string; label: string; testId?: string }) {
  return src
    ? <img src={src} alt="" data-testid={testId} draggable={false} className="absolute inset-0 w-full h-full rounded-full object-cover" />
    : <span className="text-text-muted">{initial(label)}</span>;
}

/**
 * A pattern drawn from a key: the same contact always gets the same one, so a contact with no name or
 * picture is still told apart at a glance. 5×5 cells mirrored left to right, one hue, all from the key.
 */
export function Identicon({ seed }: { seed: string }) {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619) >>> 0;
  const hue = hash % 360, bits = Math.imul(hash, 2654435761) >>> 0;
  const cells: [number, number][] = [];
  for (let i = 0; i < 15; i++) {
    if (!((bits >>> i) & 1)) continue;
    const x = Math.floor(i / 5), y = i % 5;
    cells.push([x, y]);
    if (x < 2) cells.push([4 - x, y]);
  }
  return (
    <svg viewBox="-1 -1 7 7" aria-hidden="true" data-testid="identicon" className="absolute inset-0 w-full h-full rounded-full"
      style={{ background: `hsl(${hue} 35% 88%)` }}>
      {cells.map(([x, y]) => <rect key={`${x}.${y}`} x={x} y={y} width="1.02" height="1.02" fill={`hsl(${hue} 55% 42%)`} />)}
    </svg>
  );
}

/**
 * The picture a contact shares with this chat; else their initial, or a pattern of their key when they have no name.
 * `photo`: the picture of the identity the contact is shown as (identities/contactFace.ts), which wins over theirs.
 * `presence`: the dot that says they are online (WISP 401 § Presence and status) on its corner, `<testId>-presence`;
 * its words go beside the name (PresenceMarks.tsx `PeerPresenceLine`).
 */
export function PeerAvatar({ peerPubKey, label, named = true, testId, photo, presence = false }: { peerPubKey?: string; label: string; named?: boolean; testId?: string; photo?: string; presence?: boolean }) {
  const sent = usePeerAvatar(peerPubKey);
  const src = photo ?? sent;
  const picture = !src && !named && peerPubKey ? <Identicon seed={peerPubKey} /> : <Avatar src={src} label={label} testId={testId} />;
  if (!presence) return picture;
  return <>{picture}<PeerPresenceDot peerKey={peerPubKey} testId={`${testId ?? "avatar"}-presence`} /></>;
}

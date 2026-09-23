import { usePeerAvatar } from "../hooks/useAvatars";

/**
 * A round picture, or the name's initial when there is none. `src` is a checked data URL (ours, or one
 * `sanitizeAvatar` accepted from a contact), never an address that would be fetched.
 */
export function Avatar({ src, label, testId }: { src?: string; label: string; testId?: string }) {
  return src
    ? <img src={src} alt="" data-testid={testId} draggable={false} className="absolute inset-0 w-full h-full rounded-full object-cover" />
    : <span className="text-text-muted">{label.charAt(0).toUpperCase()}</span>;
}

/** The picture a contact shares with this chat, or their initial. */
export function PeerAvatar({ peerPubKey, label, testId }: { peerPubKey?: string; label: string; testId?: string }) {
  return <Avatar src={usePeerAvatar(peerPubKey)} label={label} testId={testId} />;
}

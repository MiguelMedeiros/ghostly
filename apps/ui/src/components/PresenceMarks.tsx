import type { CSSProperties } from "react";
import { useI18n } from "../contexts/I18nContext";
import { useEngineReconnecting } from "../lib/engineState";
import { presenceLabel, presenceTone, shownAvailability, statusText, usePeerPresence, type PeerPresence, type PresenceTone } from "../lib/presence";

/*
 * A contact's presence and status (WISP 401 § Presence and status) where their chat is shown: a dot on their picture
 * while they say they are online, and the status they set (an emoji, a short text, or the availability in words)
 * beside their name. The dot is never the only way it is said: its words are in the row's name for a screen reader
 * (ChatRow's `rowLabel`), or beside it in the header and the contact panel (`PeerPresenceLine`), and in its tooltip.
 */

/**
 * Each look has a shape of its own besides its colour (green, amber, red as the WISP says): filled when online, away or
 * busy, a ring when idle, a bar across when Do not disturb.
 */
const TONES: Record<PresenceTone, string> = {
  online: "bg-success",
  idle: "border-[2.5px] border-amber-500 bg-[var(--ring,var(--theme-sidebar-bg))]",
  away: "bg-amber-500",
  busy: "bg-danger",
  dnd: "bg-danger",
};

/**
 * The dot on a contact's picture, at its bottom end corner, ringed in what is behind it (`--ring`, as the identity's
 * corner is). Hidden from a screen reader: where it is shown, its words are said with the name or beside it.
 */
export function PresenceDot({ entry, testId, size = 12 }: { entry: PeerPresence | undefined; testId: string; size?: number }) {
  const { t } = useI18n();
  const tone = presenceTone(entry);
  if (!tone) return null;
  const style: CSSProperties = { width: size, height: size, boxShadow: "0 0 0 2px var(--ring, var(--theme-sidebar-bg))" };
  return (
    <span aria-hidden="true" data-testid={testId} data-tone={tone} title={presenceLabel(t, tone)} style={style}
      className={`absolute -bottom-0.5 -end-0.5 z-10 flex items-center justify-center rounded-full forced-color-adjust-none ${TONES[tone]}`}>
      {tone === "dnd" && <span className="h-[2px] w-1/2 rounded-full bg-white" />}
    </span>
  );
}

/**
 * The same, read from the engine for a contact's key: drawn again only when theirs changes (lib/presence.ts). None
 * while the tab lost its peer (the Reconnecting notice): whether they are online is not known then.
 */
export function PeerPresenceDot({ peerKey, testId, size }: { peerKey?: string; testId: string; size?: number }) {
  const entry = usePeerPresence(peerKey);
  return <PresenceDot entry={useEngineReconnecting() ? undefined : entry} testId={testId} size={size} />;
}

/**
 * The status beside a name: the emoji, then the text (or the availability) in its own direction, cut at its own end.
 * `hidden`: the name around it says it already (the chat list's row).
 */
export function PeerStatusMark({ entry, testId, hidden = false, className = "" }: { entry: PeerPresence | undefined; testId: string; hidden?: boolean; className?: string }) {
  const { t } = useI18n();
  const emoji = entry?.status?.emoji;
  const availability = shownAvailability(entry);
  const text = entry?.status?.text ?? (availability && t(`chat.presence.availability.${availability}`));
  if (!emoji && !text) return null;
  return (
    <span aria-hidden={hidden || undefined} data-testid={testId} title={statusText(t, entry)} className={`flex min-w-0 items-center gap-1 text-text-muted ${className}`}>
      {emoji && <span data-testid={`${testId}-emoji`} className="shrink-0">{emoji}</span>}
      {text && <bdi data-testid={`${testId}-text`} dir="auto" className="min-w-0 truncate">{text}</bdi>}
    </span>
  );
}

/**
 * A phone's emoji alone, whole or not shown: a line of `text-xs` (16 px) high that wraps, its empty `::before` first
 * and no gap after it, so an emoji with no room left goes to the second line, which `overflow-hidden` cuts away.
 */
const GIVES_WAY = "max-md:h-4 max-md:flex-wrap max-md:gap-0 max-md:overflow-hidden max-md:before:h-full max-md:before:content-['']";

/**
 * The contact's presence and status in words beside their name (the chat's header, the contact panel): the dot's words
 * for a screen reader only (the dot is on the picture), and the status shown. Nothing while they say nothing.
 * `emojiOnPhone`: a phone shows the status's emoji alone, its text for a screen reader (the chat's header).
 * With nothing to see (online with no status, or on such a phone a status with no emoji), the line is out of the row's
 * flow: an empty item still took the row's gap from the name beside it, 4 px of a long name on a 390 px phone.
 * On such a phone the emoji shows whole or not at all, in the room the name leaves it (the header gives the name its
 * room first): the line is one line high and wraps, behind an empty first item (its `::before`), so an emoji wider
 * than what is left goes to a second line, cut away, rather than half drawn or over the buttons beside it.
 */
export function PeerPresenceLine({ peerKey, testId, className = "", emojiOnPhone = false }: { peerKey?: string; testId: string; className?: string; emojiOnPhone?: boolean }) {
  const { t } = useI18n();
  const entry = usePeerPresence(peerKey);
  // The dot's words go with it while the tab lost its peer; the status they set is the last one known, and stays.
  const tone = useEngineReconnecting() ? undefined : presenceTone(entry);
  const shown = statusText(t, entry);
  if (!tone && !shown) return null;
  // Each class whole in the source, for Tailwind to find it.
  const unseen = !shown ? "sr-only" : !emojiOnPhone ? "" : entry?.status?.emoji ? `max-md:[&_bdi]:sr-only ${GIVES_WAY}` : "max-md:[&_bdi]:sr-only max-md:sr-only";
  return (
    <span data-testid={testId} className={`flex min-w-0 items-center gap-1 ${unseen} ${className}`}>
      {tone && <span data-testid={`${testId}-presence`} className="sr-only">{presenceLabel(t, tone)}</span>}
      <PeerStatusMark entry={entry} testId={`${testId}-status`} />
    </span>
  );
}

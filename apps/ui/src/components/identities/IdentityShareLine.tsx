import { useEffect, useId, useReducer, type PointerEvent } from "react";
import type { IdentityTimelineEntry } from "@ghostly/core";
import { IDENTITY_CHALLENGE_WINDOW, identityRefusal } from "@ghostly/core";
import type { LinkView } from "@ghostly/browser/shared/types";
import { focus } from "../../lib/connection";
import { clockTime } from "../../lib/time";
import { receivedRefusal, useEngineValue } from "../../lib/identities";
import { playSwitch, reducedMotion } from "../deck/motion";
import "../deck/deck.css";
import { IdCardFace } from "./IdCardFace";
import { idCardTone, shareIdCard, type ShareState } from "./idCard";
import { ProviderMark } from "./ProviderMark";
import { useI18n } from "../../contexts/I18nContext";
import "./identity-share.css";
import { problemLine } from "../../lib/problemText";
import { fillNames, fillNodes } from "../../lib/fillNodes";

/**
 * Where a share stands now. A share that stopped later (the next entry of that identity on that side is a stop) is
 * withdrawn or revoked, whatever its check had said. Else its entry's state, told apart where the entry alone cannot
 * say it: mine not sent yet is waiting, theirs never presented is unanswered. A verified share no longer held (theirs
 * gone from what this app keeps, a newer proof of it took its place; mine no longer shared) is no longer shared, even
 * with no stop on the timeline: it never says Verified on the entry's word alone.
 */
function shareState(entry: IdentityTimelineEntry, link: Pick<LinkView, "identities" | "identityTimeline"> | undefined, now = Date.now()): ShareState {
  const timeline = link?.identityTimeline ?? [];
  const i = timeline.findIndex(e => e.id === entry.id);
  const next = i < 0 ? undefined : timeline.slice(i + 1).find(e => e.side === entry.side && e.proof === entry.proof);
  if (next?.kind === "stopped") return next.reason === "revoked" ? "revoked" : "withdrawn";
  const held = link?.identities && (entry.side === "theirs"
    ? link.identities.received.some(r => r.id === entry.proof)
    : !["withdrawn", "withdrawal-pending"].includes(link.identities.shared.find(s => s.id === entry.proof)?.status ?? ""));
  if (entry.state === "verified" && held === false) return "withdrawn";
  if (entry.state === "verified" || entry.state === "failed") return entry.state;
  if (entry.side === "mine") return link?.identities?.shared.find(s => s.id === entry.proof)?.status === "queued" ? "waiting" : "verifying";
  // The contact asked for a challenge and never answered it: it can no longer be answered.
  return now - entry.at > IDENTITY_CHALLENGE_WINDOW * 1000 ? "unanswered" : "verifying";
}

/**
 * An identity shared in the chat, as its timeline shows it, on both sides: the identity's ID card, the one the
 * picker and the Identities page show (IdCardFace.tsx), centred like the transport lines, and under it who shared it
 * and when. The card's status corner is the share's state: checking, then verified or not, and later no longer
 * shared or revoked, on the same card. With a mouse the card lifts under the pointer and plays the deck's flourish
 * once (deck/motion.ts: a swing, a sheen, the ghost peeking in); on a touch screen, and with reduced motion, it is
 * still. A stop is a line of its own, after the card. Local only: not a message, never sent, never unread. The card
 * is a button: it opens the chat's identities on that card.
 */
export function IdentityShareLine({ entry, link, contact, onOpen }: { entry: IdentityTimelineEntry; link: Pick<LinkView, "identities" | "identityTimeline"> | undefined; contact: string; onOpen: (entry: IdentityTimelineEntry) => void }) {
  const mine = entry.side === "mine";
  // My proof as this app holds it now, and nothing else of the engine's state: the chat's timeline shows one line per
  // share, and on the whole state each was drawn again on every state (up to 20 a second while a file moves).
  const proof = useEngineValue(state => (mine ? state?.identityProofs?.find(p => p.id === entry.proof) : undefined));
  const { t, language } = useI18n();
  const id = useId();
  const time = <time dateTime={new Date(entry.at).toISOString()} className="shrink-0 text-[10px] text-text-muted">{clockTime(entry.at, language)}</time>;
  // The identity as this app holds it now (mine: my proof, theirs: what the contact presented), else as the entry kept it.
  const state: ShareState = entry.kind === "stopped" ? (entry.reason === "revoked" ? "revoked" : "withdrawn") : shareState(entry, link);
  // The contact's share still being checked turns Not checked when its window ends: nothing else draws the line again
  // then. Once more after each wake while it still checks (a clock set back wakes it early). Never past the longest a
  // timer holds (about 24.8 days): one set further fires at once, and each wake set the next, a draw every millisecond.
  const [wakes, wake] = useReducer((n: number) => n + 1, 0);
  const expires = state === "verifying" && !mine ? entry.at + IDENTITY_CHALLENGE_WINDOW * 1000 : undefined;
  useEffect(() => {
    if (expires === undefined) return;
    const timer = setTimeout(wake, Math.min(Math.max(0, expires - Date.now()) + 1, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [expires, wakes]);
  const card = shareIdCard(entry, state, {
    proof,
    received: mine ? undefined : link?.identities?.received.find(r => r.id === entry.proof),
    contact, t, language,
  });
  // The contact's name and the identity, each its own <bdi> in the sentence as fillNames puts them, the handle left to
  // right as on the card's face: "Ana (work)" and "GitHub (SSH key)" keep their brackets on their side in Arabic.
  const names = { contact: <bdi>{contact}</bdi>, what: <bdi>{card.label}{card.subject && <> · <bdi dir="ltr">{card.short}</bdi></>}</bdi> };
  if (entry.kind === "stopped") {
    const text = fillNodes(t(entry.reason === "revoked"
      ? (mine ? "identities.share.revokedMine" : "identities.share.revokedTheirs")
      : (mine ? "identities.share.stoppedMine" : "identities.share.stoppedTheirs")), names);
    return (
      <div className="mb-3.5 flex flex-col items-center message-row-x" data-testid="identity-share" data-side={entry.side} data-kind="stopped">
        <button type="button" onClick={() => onOpen(entry)}
          className={`inline-flex max-w-full items-center gap-1.5 rounded-lg bg-surface-alt/80 px-3 py-1.5 text-start text-xs text-text-secondary transition-colors hover:bg-surface-hover ${focus}`}>
          <span className="opacity-60 grayscale"><ProviderMark provider={entry.provider} subject={card.bound} small /></span>
          <span className="min-w-0 break-words" data-testid="identity-share-text">{text}</span>
          {time}
        </button>
      </div>
    );
  }
  // Mine refused: only a refusal this app writes, never the contact's own words as this app's line (identityRefusal).
  const why = state !== "failed" ? undefined : mine ? identityRefusal(entry.error) : entry.error;
  // The line is cut to one row: its tooltip reads it in full, in the same words (never the English it came from).
  // Theirs refused here: said from this side (receivedRefusal), not in the words the contact was sent.
  const reason = why && (mine ? problemLine(why, t, "proof") : receivedRefusal(why, t));
  // A mouse over the card: the deck's flourish, once (it ends at rest by itself). Never for a finger, nor with reduced motion.
  const flourish = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse" && !reducedMotion()) playSwitch({ glow: null, incoming: e.currentTarget, outgoing: null, dir: 1 });
  };
  return (
    <div className="mb-3.5 flex flex-col items-center gap-1.5 message-row-x" data-testid="identity-share" data-side={entry.side} data-kind="shared" data-state={state}>
      {/* Left to right in every language, as in the deck: the card is laid out in physical pixels. Named by what its face
          shows (Label in Name: a voice-control user says those words); who shared it, and why it failed, describe it. */}
      <button type="button" dir="ltr" onClick={() => onOpen(entry)} onPointerEnter={flourish} data-testid="identity-share-card"
        aria-describedby={why ? `${id}-caption ${id}-reason` : `${id}-caption`}
        className={`identity-share-card ${idCardTone({ provider: card.provider, subject: card.bound, attested: card.attested })}`}>
        <IdCardFace card={card} />
      </button>
      <p className="m-0 inline-flex max-w-full items-baseline gap-1.5 rounded-lg bg-surface-alt/80 px-2.5 py-1 text-xs text-text-secondary">
        <span id={`${id}-caption`} className="min-w-0 truncate" data-testid="identity-share-text">{mine ? t("identities.share.captionMine") : fillNames(t("identities.share.captionTheirs"), { contact })}</span>
        {time}
      </p>
      {reason && <p id={`${id}-reason`} className="m-0 max-w-full truncate text-[11px] text-danger-ink" data-testid="identity-share-reason" title={reason}>{reason}</p>}
    </div>
  );
}

import type { PointerEvent } from "react";
import type { IdentityTimelineEntry } from "@ghostly/core";
import { IDENTITY_CHALLENGE_WINDOW } from "@ghostly/core";
import type { LinkView } from "@ghostly/browser/shared/types";
import { focus } from "../../lib/connection";
import { clockTime } from "../../lib/time";
import { useEngineState } from "../../lib/identities";
import { playSwitch, reducedMotion } from "../deck/motion";
import "../deck/deck.css";
import { IdCardFace } from "./IdCardFace";
import { idCardTone, shareIdCard, type ShareState } from "./idCard";
import { ProviderMark } from "./ProviderMark";
import { useI18n } from "../../contexts/I18nContext";
import "./identity-share.css";
import { problemLine } from "../../lib/problemText";

/**
 * Where a share stands now. A share that stopped later (the next entry of that identity on that side is a stop) is
 * withdrawn or revoked, whatever its check had said. Else its entry's state, told apart where the entry alone cannot
 * say it: mine not sent yet is waiting, theirs never presented is unanswered.
 */
function shareState(entry: IdentityTimelineEntry, link: Pick<LinkView, "identities" | "identityTimeline"> | undefined, now = Date.now()): ShareState {
  const timeline = link?.identityTimeline ?? [];
  const i = timeline.findIndex(e => e.id === entry.id);
  const next = i < 0 ? undefined : timeline.slice(i + 1).find(e => e.side === entry.side && e.proof === entry.proof);
  if (next?.kind === "stopped") return next.reason === "revoked" ? "revoked" : "withdrawn";
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
export function IdentityShareLine({ entry, link, contact, onOpen }: { entry: IdentityTimelineEntry; link: LinkView | undefined; contact: string; onOpen: (entry: IdentityTimelineEntry) => void }) {
  const engine = useEngineState();
  const { t, language } = useI18n();
  const mine = entry.side === "mine";
  const time = <time dateTime={new Date(entry.at).toISOString()} className="shrink-0 text-[10px] text-text-muted">{clockTime(entry.at, language)}</time>;
  // The identity as this app holds it now (mine: my proof, theirs: what the contact presented), else as the entry kept it.
  const state: ShareState = entry.kind === "stopped" ? (entry.reason === "revoked" ? "revoked" : "withdrawn") : shareState(entry, link);
  const card = shareIdCard(entry, state, {
    proof: mine ? engine?.identityProofs?.find(p => p.id === entry.proof) : undefined,
    received: mine ? undefined : link?.identities?.received.find(r => r.id === entry.proof),
    contact, t, language,
  });
  const what = card.subject ? `${card.label} · ${card.short}` : card.label;
  if (entry.kind === "stopped") {
    const text = entry.reason === "revoked"
      ? (mine ? t("identities.share.revokedMine", { what }) : t("identities.share.revokedTheirs", { contact, what }))
      : (mine ? t("identities.share.stoppedMine", { what }) : t("identities.share.stoppedTheirs", { contact, what }));
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
  const words = state === "failed" && entry.error ? t("identities.share.notVerifiedWhy", { error: problemLine(entry.error, t) }) : card.statusLabel;
  // A mouse over the card: the deck's flourish, once (it ends at rest by itself). Never for a finger, nor with reduced motion.
  const flourish = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse" && !reducedMotion()) playSwitch({ glow: null, incoming: e.currentTarget, outgoing: null, dir: 1 });
  };
  return (
    <div className="mb-3.5 flex flex-col items-center gap-1.5 message-row-x" data-testid="identity-share" data-side={entry.side} data-kind="shared" data-state={state}>
      {/* Left to right in every language, as in the deck: the card is laid out in physical pixels. */}
      <button type="button" dir="ltr" onClick={() => onOpen(entry)} onPointerEnter={flourish} data-testid="identity-share-card"
        aria-label={mine ? t("identities.share.sharedMineState", { what, state: words }) : t("identities.share.sharedTheirsState", { contact, what, state: words })}
        className={`identity-share-card ${idCardTone({ provider: card.provider, subject: card.bound, attested: card.attested })}`}>
        <IdCardFace card={card} />
      </button>
      <p className="m-0 inline-flex max-w-full items-baseline gap-1.5 rounded-lg bg-surface-alt/80 px-2.5 py-1 text-xs text-text-secondary">
        <span className="min-w-0 truncate" data-testid="identity-share-text">{mine ? t("identities.share.captionMine") : t("identities.share.captionTheirs", { contact })}</span>
        {time}
      </p>
      {state === "failed" && entry.error && <p className="m-0 max-w-full truncate text-[11px] text-danger-ink" data-testid="identity-share-reason" title={entry.error}>{problemLine(entry.error, t)}</p>}
    </div>
  );
}

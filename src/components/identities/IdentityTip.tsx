import { createPortal } from "react-dom";
import { isGood, type Badge } from "./contactBadges";
import { BadgeMark } from "./BadgeMark";
import type { TipAt } from "./markTip";

/*
 * A contact's identity marks name themselves in a small card: the chat list's marks and the header's stack, the same
 * card in both. It opens on a mouse hover after a short pause, at once on keyboard focus, and on a long press on a touch
 * screen (markTip.ts); it never takes the pointer, so it never covers a click, and nothing about it opens the chat.
 */

const CHECK = <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** One identity in the card: its picture (or the provider's mark), name, handle or subject, state, and where the profile came from. */
function TipIdentity({ badge: b }: { badge: Badge }) {
  const good = isGood(b.state);
  return (
    <div className="identity-tip-row" data-testid="identity-tip-identity" data-provider={b.provider} data-state={b.state}>
      <BadgeMark provider={b.provider} subject={b.subject} state={b.state} photo={b.photo} size={32} data-testid="identity-tip-mark" />
      <span className="identity-tip-text">
        <bdi className="identity-tip-name" data-testid="identity-tip-name">{b.name ?? b.short}</bdi>
        <span className="identity-tip-sub">{b.providerName}{b.name ? <> · <bdi>{b.handle ?? b.short}</bdi></> : null}</span>
        <span className="identity-tip-state" data-good={good || undefined} data-testid="identity-tip-state">{good && CHECK}{capital(b.stateText)}</span>
        {b.hosts && <span className="identity-tip-source" data-testid="identity-tip-source">Loaded from {b.hosts.join(", ")}</span>}
      </span>
    </div>
  );
}

/** The card, over everything (a portal), never taking the pointer. `text` instead of identities: a plain line. */
export function IdentityTip({ id, testId, at, badges, text, footer }: { id: string; testId: string; at: TipAt; badges: Badge[]; text?: string; footer?: string }) {
  return createPortal(
    <div id={id} role="tooltip" className="identity-tip" data-testid={testId} style={{ top: at.top, bottom: at.bottom, left: at.left }}>
      {text ? <p className="identity-tip-line">{text}</p> : badges.map(b => <TipIdentity key={b.id} badge={b} />)}
      {footer && <p className="identity-tip-line identity-tip-footer" data-testid="identity-tip-footer">{footer}</p>}
    </div>,
    document.body,
  );
}

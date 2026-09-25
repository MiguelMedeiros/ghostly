import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { BADGE_LIMITS, contactBadges, isGood, takeBadges, useReceived, type Badge, type BadgeState } from "./contactBadges";
import { providerIcon } from "./ProviderIcons";
import "./contact-marks.css";

const CLOCK = <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="2" /><path d="M8 5v3.2l2 1.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;
const CHECK = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;

/**
 * One identity's mark, with its state drawn over the tile (contactBadges.ts): the provider's colour when verified, a
 * clock when it expires soon, an amber dot when a check failed, greyed when expired and struck through when revoked.
 */
export function BadgeMark({ provider, subject, state, size, ...rest }: { provider: string; subject?: string; state: BadgeState; size?: number } & Record<`data-${string}`, string | number | undefined>) {
  const icon = providerIcon(provider, subject);
  const style = size ? ({ "--mark": `${size}px` } as CSSProperties) : undefined;
  return (
    <span className="badge-mark" data-state={state} data-icon={icon?.key ?? provider} style={style} aria-hidden="true" {...rest}>
      <span className={`badge-mark-tile ${icon ? icon.tile : "badge-mark-plain"}`}>
        {icon ? icon.mark(10) : <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="4" /></svg>}
      </span>
      {state === "expiring" && <span className="badge-mark-flag" data-flag="expiring">{CLOCK}</span>}
      {state === "failed" && <span className="badge-mark-flag" data-flag="failed" />}
    </span>
  );
}

/** "+N": how many more there are, as a chip. `data-wide`/`data-narrow` pick the one a row of that width shows. */
function More({ n, ...rest }: { n: number } & Record<`data-${string}`, string | undefined>) {
  return n > 0 ? <span className="contact-marks-more" {...rest}>+{n}</span> : null;
}

/**
 * Beside a contact's name in the chat list and in a group's member list: the identities they shared and this app
 * verified, as tiny marks (no text), at most two in BADGE_ORDER, and "+N" for the rest. A narrow row (its parent is
 * the `contact-row` container) shows one mark and counts the other, so the name gives way before the time does.
 */
export function ContactMarks({ peerKey, testId = "contact-marks" }: { peerKey: string | undefined; testId?: string }) {
  const received = useReceived(peerKey);
  const badges = contactBadges(received, { good: true });
  if (!badges.length) return null;
  const { shown, more } = takeBadges(badges, BADGE_LIMITS.row);
  const label = `Verified identities: ${badges.map(b => b.label).join("; ")}`;
  return (
    <span className="contact-marks" data-testid={testId} data-count={badges.length} role="img" aria-label={label} title={badges.map(b => b.label).join("\n")}>
      {shown.map((b, i) => <BadgeMark key={b.id} provider={b.provider} subject={b.subject} state={b.state} data-testid="contact-mark" data-wide={i > 0 ? "" : undefined} />)}
      <More n={more} data-wide="" data-testid="contact-marks-more" />
      <More n={badges.length - BADGE_LIMITS.rowNarrow} data-narrow="" />
    </span>
  );
}

/** Where a tooltip goes: under its mark, kept on screen. */
const tipAt = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { top: r.bottom + 6, left: Math.max(8, Math.min(r.left + r.width / 2 - 140, window.innerWidth - 288)) };
};

/**
 * The chat header's badge: the contact's identities stacked like avatars (every state, the vouched-for ones first,
 * then BADGE_ORDER), up to three in a wide column, two in a narrow one and one on a phone (the `chat-column`
 * container), "+N" for the rest, and one check when every mark shown is verified. Hovering a mark, or a long press
 * on a touch screen, names it: "GitHub: mmedeiros · verified 2 h ago". A click opens the contact's identities.
 */
export function IdentityStack({ peerKey, onOpen, open }: { peerKey: string; onOpen: () => void; open?: boolean }) {
  const received = useReceived(peerKey);
  const badges = contactBadges(received);
  const [tip, setTip] = useState<{ badge: Badge; top: number; left: number } | null>(null);
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; held: boolean }>({ held: false });
  const hide = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { clearTimeout(press.current.timer); clearTimeout(hide.current); }, []);
  if (!badges.length) return null;
  const shown = badges.slice(0, BADGE_LIMITS.header);
  const allGood = (n: number) => shown.slice(0, n).every(b => isGood(b.state));
  const markOf = (e: PointerEvent) => (e.target as Element).closest<HTMLElement>("[data-badge]");
  const show = (el: HTMLElement | null) => {
    const badge = el && badges.find(b => b.id === el.dataset.badge);
    setTip(badge ? { badge, ...tipAt(el) } : null);
  };
  const label = badges.map(b => b.label).join("; ");
  return (
    <>
      <button type="button" className="identity-stack" data-testid="chat-identity-badges" data-count={badges.length} aria-expanded={open} aria-label={`Identities: ${label}`}
        onClick={e => { if (press.current.held) { e.preventDefault(); press.current.held = false; return; } onOpen(); }}
        onPointerOver={e => { if (e.pointerType === "mouse") show(markOf(e)); }}
        onPointerLeave={e => { if (e.pointerType === "mouse") setTip(null); }}
        onPointerDown={e => {
          if (e.pointerType === "mouse") return;
          const el = markOf(e);
          press.current.held = false;
          clearTimeout(press.current.timer);
          press.current.timer = setTimeout(() => { press.current.held = true; show(el); clearTimeout(hide.current); hide.current = setTimeout(() => setTip(null), 2500); }, 450);
        }}
        onPointerUp={() => clearTimeout(press.current.timer)}
        onPointerCancel={() => clearTimeout(press.current.timer)}
        onContextMenu={e => { if (press.current.held) e.preventDefault(); }}>
        <span className="identity-stack-marks">
          {shown.map(b => <BadgeMark key={b.id} provider={b.provider} subject={b.subject} state={b.state} data-badge={b.id} data-testid="chat-identity-badge" />)}
        </span>
        {([3, 2, 1] as const).map(n => (
          <span key={n} data-upto={n}>
            {badges.length > n && <span className="contact-marks-more" data-testid={`chat-identity-more-${n}`}>+{badges.length - n}</span>}
            {allGood(n) && <span className="identity-stack-check" data-testid={`chat-identity-check-${n}`}>{CHECK}</span>}
          </span>
        ))}
      </button>
      {tip && createPortal(<div role="tooltip" className="badge-tip" data-testid="chat-identity-tip" style={{ top: tip.top, left: tip.left }}>{tip.badge.label}</div>, document.body)}
    </>
  );
}

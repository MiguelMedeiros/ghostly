import { useId } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { BADGE_LIMITS, contactBadges, isGood, takeBadges, useReceived } from "./contactBadges";
import { BadgeMark } from "./BadgeMark";
import { GHOSTLY } from "./idCard";
import { IdentityTip } from "./IdentityTip";
import { ALL_MARKS, loadShownProfiles, useMarkTip } from "./markTip";
import { PROVIDER_ICONS, providerIcon } from "./ProviderIcons";
import type { ContactFace } from "./contactFace";
import "./contact-marks.css";

export { BadgeMark };

const CHECK = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;

/** "+N": how many more there are, as a chip. `data-wide`/`data-narrow` pick the one a row of that width shows. */
function More({ n, ...rest }: { n: number } & Record<`data-${string}`, string | undefined>) {
  return n > 0 ? <span className="contact-marks-more" {...rest}>+{n}</span> : null;
}

/**
 * Beside a contact's name in the chat list and in a group's member list: the identities they shared and this app
 * verified, as tiny marks (no text), at most two in BADGE_ORDER, and "+N" for the rest. A narrow row (its parent is
 * the `contact-row` container) shows one mark and counts the other, so the name gives way before the time does.
 * A mark names itself in a card (IdentityTip.tsx) on hover, keyboard focus or a long press; the "+N" and the keys
 * name them all. None of it opens the chat: the card never takes the pointer, and the click ending a long press is
 * eaten. The row's own tooltip (its name and key) stays off the marks, so the two never cover each other.
 */
export function ContactMarks({ peerKey, testId = "contact-marks" }: { peerKey: string | undefined; testId?: string }) {
  const received = useReceived(peerKey);
  const badges = contactBadges(received, { good: true });
  const tipId = useId();
  const pick = (key: string) => (key === ALL_MARKS ? badges : badges.filter(b => b.id === key));
  const { tip, handlers, swallow } = useMarkTip(key => loadShownProfiles(pick(key)));
  if (!badges.length) return null;
  const { shown, more } = takeBadges(badges, BADGE_LIMITS.row);
  const label = `Verified identities: ${badges.map(b => b.label).join("; ")}`;
  const inTip = tip ? pick(tip.key) : [];
  return (
    <>
      <span className="contact-marks" data-testid={testId} data-count={badges.length} role="img" aria-label={label} tabIndex={0} title=""
        aria-describedby={inTip.length ? tipId : undefined} {...handlers} onClick={swallow}>
        {shown.map((b, i) => <BadgeMark key={b.id} provider={b.provider} subject={b.subject} state={b.state} data-badge={b.id} data-testid="contact-mark" data-wide={i > 0 ? "" : undefined} />)}
        <More n={more} data-wide="" data-testid="contact-marks-more" />
        <More n={badges.length - BADGE_LIMITS.rowNarrow} data-narrow="" />
      </span>
      {tip && inTip.length > 0 && <IdentityTip id={tipId} testId={`${testId}-tip`} at={tip} badges={inTip} />}
    </>
  );
}

/**
 * The chat header's badge: the contact's identities stacked like avatars (every state, the vouched-for ones first,
 * then BADGE_ORDER), up to three in a wide column, two in a narrow one and one on a phone (the `chat-column`
 * container), "+N" for the rest, and one check when every mark shown is verified. Hovering a mark, focusing the stack
 * from the keyboard or a long press on a touch screen opens the same card as the chat list's marks. A click opens the
 * contact's identities. A contact who shared none still has a mark: their Ghostly identity, the panel's first card,
 * quiet on a plain tile and with no check (it proves nothing), so every chat reaches the contact's identities from its
 * header. `footer`: a last line for the card (whose name and photo the contact is shown with).
 */
export function IdentityStack({ peerKey, name, onOpen, open, footer }: { peerKey: string; name: string; onOpen: () => void; open?: boolean; footer?: string }) {
  const { t } = useI18n();
  const received = useReceived(peerKey);
  const badges = contactBadges(received);
  const tipId = useId();
  const shown = badges.slice(0, BADGE_LIMITS.header);
  const allGood = (n: number) => shown.length > 0 && shown.slice(0, n).every(b => isGood(b.state));
  // Nothing shared: the Ghostly mark says what the panel holds, the way a proof's mark names the proof.
  const ghostly = shown.length ? undefined : `${t("identities.ghostly.theirs")}. ${t("identities.ghostly.nothingElse", { name })}`;
  const pick = (key: string) => (key === ALL_MARKS ? badges : badges.filter(b => b.id === key));
  // A mark named on screen is a card on screen: its public profile's name comes into the card once read.
  const { tip, handlers, swallow } = useMarkTip(key => loadShownProfiles(pick(key)));
  const label = ghostly ?? badges.map(b => b.label).join("; ");
  // Worked out on every render, so a profile read while the card is open shows itself there.
  const inTip = tip && !ghostly ? pick(tip.key) : [];
  return (
    <>
      <button type="button" className="identity-stack" data-testid="chat-identity-badges" data-count={badges.length} aria-expanded={open} aria-label={`Identities with ${name}: ${label}`}
        aria-describedby={tip ? tipId : undefined} {...handlers}
        onClick={e => { if (!swallow(e)) onOpen(); }}>
        <span className="identity-stack-marks">
          {ghostly
            ? <span className="badge-mark" data-state={GHOSTLY} data-icon={GHOSTLY} data-badge={GHOSTLY} data-testid="chat-identity-ghostly-mark" aria-hidden="true">
              <span className="badge-mark-tile badge-mark-plain">{PROVIDER_ICONS[GHOSTLY].mark(10)}</span>
            </span>
            : shown.map(b => <BadgeMark key={b.id} provider={b.provider} subject={b.subject} state={b.state} photo={b.photo} data-badge={b.id} data-testid="chat-identity-badge" />)}
        </span>
        {([3, 2, 1] as const).map(n => (
          <span key={n} data-upto={n}>
            {badges.length > n && <span className="contact-marks-more" data-testid={`chat-identity-more-${n}`}>+{badges.length - n}</span>}
            {allGood(n) && <span className="identity-stack-check" data-testid={`chat-identity-check-${n}`}>{CHECK}</span>}
          </span>
        ))}
      </button>
      {tip && (ghostly || inTip.length > 0) && <IdentityTip id={tipId} testId="chat-identity-tip" at={tip} badges={inTip} text={ghostly} footer={ghostly ? undefined : footer} />}
    </>
  );
}

/** On the avatar of a contact shown as one of their identities (contactFace.ts): that identity's provider, small. */
export function FaceCorner({ face }: { face: ContactFace }) {
  const icon = providerIcon(face.provider, face.subject);
  return (
    <span role="img" aria-label={`${face.providerName} profile`} data-testid="contact-face-corner" data-provider={face.provider}
      className={`face-corner forced-color-adjust-none ${icon?.tile ?? "badge-mark-plain"}`}>{icon?.mark(10)}</span>
  );
}

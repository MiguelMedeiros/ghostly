import type { CSSProperties } from "react";
import type { BadgeState } from "./contactBadges";
import { providerIcon } from "./ProviderIcons";
import "./contact-marks.css";

const CLOCK = <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="2" /><path d="M8 5v3.2l2 1.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;

/**
 * One identity's mark, with its state drawn over the tile (contactBadges.ts): the provider's colour when verified, a
 * clock when it expires soon, an amber dot when a check failed, greyed when expired and struck through when revoked.
 * With a `photo` (its public profile's picture, in the header), the picture fills the mark and the provider's mark
 * becomes a small badge on its corner.
 */
export function BadgeMark({ provider, subject, state, size, photo, ...rest }: { provider: string; subject?: string; state: BadgeState; size?: number; photo?: string } & Record<`data-${string}`, string | number | undefined>) {
  const icon = providerIcon(provider, subject);
  const style = size ? ({ "--mark": `${size}px` } as CSSProperties) : undefined;
  const tile = icon ? icon.tile : "badge-mark-plain";
  const mark = icon ? icon.mark(10) : <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="4" /></svg>;
  return (
    <span className="badge-mark" data-state={state} data-icon={icon?.key ?? provider} data-photo={photo ? "" : undefined} style={style} aria-hidden="true" {...rest}>
      {photo
        ? <><span className="badge-mark-tile badge-mark-picture"><img src={photo} alt="" width={20} height={20} decoding="async" draggable={false} data-testid="badge-mark-photo" /></span>
          <span className={`badge-mark-corner ${tile}`}>{mark}</span></>
        : <span className={`badge-mark-tile ${tile}`}>{mark}</span>}
      {state === "expiring" && <span className="badge-mark-flag" data-flag="expiring">{CLOCK}</span>}
      {state === "failed" && <span className="badge-mark-flag" data-flag="failed" />}
    </span>
  );
}

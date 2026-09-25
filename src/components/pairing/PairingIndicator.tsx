import { useId, useState } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { useNow, type PairingProgressState } from "../../hooks/usePairingProgress";
import { SLOW_AFTER_MS, failureReason, formatElapsed } from "../../lib/pairingProgress";
import { usePairingWords } from "./words";
import "./pairing-scene.css";

/**
 * The pairing scene's state in the chat header, until the chat is live: two dots and a packet between them, the
 * step and its time beside it where there is room, and the whole sentence in a tooltip and the accessible name.
 * A click brings the scene into view.
 */
export function PairingIndicator({ progress, onOpen }: { progress: PairingProgressState; onOpen?(): void }) {
  const { t } = useI18n();
  const words = usePairingWords();
  const { stage, role } = progress;
  const ticking = stage !== "live" && stage !== "failed";
  const now = useNow(ticking);
  // `now` only ticks; a stage that began after its last tick still reads from the clock.
  const inStage = Math.max(0, Math.max(now, Date.now()) - progress.since);
  const label = words.stage(stage, role);
  const slow = ticking && inStage >= SLOW_AFTER_MS[stage] ? words.slow(stage) : "";
  const failure = stage === "failed" ? words.reason(failureReason(progress.reason)) : "";
  const [tip, setTip] = useState(false);
  const tipId = useId();
  const time = ticking ? formatElapsed(inStage) : "";
  // Packets travel toward the contact while this side is the one reaching out, and back while it answers.
  const direction = stage === "answering" && role === "joiner" ? "in" : "out";
  return <span className="relative inline-flex min-w-0">
    <button type="button" className="pi" data-testid="pairing-indicator" data-stage={stage} data-direction={direction}
      aria-label={t("pairing.indicator", { stage: label })} aria-describedby={tipId} onClick={onOpen}
      onPointerEnter={e => { if (e.pointerType !== "touch") setTip(true); }} onPointerLeave={() => setTip(false)}
      onFocus={e => { if (e.currentTarget.matches(":focus-visible")) setTip(true); }} onBlur={() => setTip(false)}
      onKeyDown={e => { if (e.key === "Escape" && tip) { e.stopPropagation(); setTip(false); } }}>
      <svg width="24" height="10" viewBox="0 0 24 10" aria-hidden="true">
        <line className="pi-line" x1="4" y1="5" x2="20" y2="5" />
        <circle className="pi-me" cx="3" cy="5" r="3" />
        <circle className="pi-end" cx="21" cy="5" r="3" />
        <circle className="pi-packet" cx="4" cy="5" r="1.6" />
      </svg>
      <span className="pi-text max-md:hidden" aria-hidden="true">{words.step(stage)}{time && ` · ${time}`}</span>
    </button>
    <span role="tooltip" id={tipId} data-testid="pairing-indicator-tip" className={`pi-tip ${tip ? "" : "invisible"}`}>
      {label}{time && ` · ${time}`}
      {slow && <span className="mt-0.5 block text-text-secondary">{slow}</span>}
      {failure && <span className="mt-0.5 block text-danger">{failure}</span>}
    </span>
  </span>;
}

import { forwardRef, type HTMLAttributes } from "react";

/** Bars never vanish entirely: silence is still a line you can aim at. */
const MIN_HEIGHT = 12;

function Bars({ peaks, className }: { peaks: number[]; className: string }) {
  return (
    <span className={`voice-wave-bars ${className}`} aria-hidden="true">
      {peaks.map((peak, i) => (
        <span key={i} className="voice-wave-bar" style={{ height: `${Math.max(MIN_HEIGHT, (peak / 255) * 100)}%` }} />
      ))}
    </span>
  );
}

/**
 * A recording's shape: two copies of the bars, the upper one clipped to `--voice-progress`
 * (0-1), which the player sets on the element itself so playing re-renders nothing.
 * Always left to right, like the sound.
 */
export const Waveform = forwardRef<HTMLDivElement, { peaks: number[]; knob?: boolean } & HTMLAttributes<HTMLDivElement>>(
  function Waveform({ peaks, knob, className = "", ...rest }, ref) {
    return (
      <div ref={ref} dir="ltr" className={`voice-wave ${className}`} {...rest}>
        <Bars peaks={peaks} className="voice-wave-base" />
        <Bars peaks={peaks} className="voice-wave-fill" />
        {knob && <span className="voice-wave-knob" />}
      </div>
    );
  },
);

/** The last moments of a recording as it happens, newest on the right. */
export function LiveWaveform({ levels, bars = 40, className = "" }: { levels: number[]; bars?: number; className?: string }) {
  const shown = levels.slice(-bars);
  const padded = [...new Array<number>(Math.max(0, bars - shown.length)).fill(0), ...shown];
  return (
    <div className={`voice-live flex-1 min-w-0 ${className}`} aria-hidden="true" data-testid="voice-live">
      {padded.map((level, i) => (
        <span key={i} style={{ height: `${Math.max(8, Math.min(1, level) * 100)}%` }} />
      ))}
    </div>
  );
}

import type { PairingStage } from "../../lib/pairingProgress";
import "./pairing-scene.css";

/**
 * The pairing scene in small, as the connection icon while a first pairing is on its way: this side, the contact,
 * and a packet between them, moving toward the contact while this side reaches out and back while it answers.
 * Still under reduced motion.
 */
export function PairingGlyph({ stage, direction, size }: { stage: PairingStage; direction: "in" | "out"; size: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" className="pg shrink-0" data-testid="pairing-glyph" data-stage={stage} data-direction={direction}>
    <line className="pi-line" x1="7" y1="12" x2="17" y2="12" />
    <circle className="pi-me" cx="3.5" cy="12" r="3.5" />
    <circle className="pi-end" cx="20.5" cy="12" r="3.5" />
    <circle className="pi-packet" cx="5" cy="12" r="2" />
  </svg>;
}

// Copied from src/components/deck/motion.ts by website/scripts/sync-app-deck.mjs. Edit the app's file, then run npm run sync:app-deck.
/**
 * The flourish when a deck's chosen card changes (Deck.tsx): the card that comes up swings forward with a small
 * overshoot, the one it replaces tucks back into the deck, a sheen in the new card's ink sweeps across it, its ghost
 * peeks in and the glow behind the deck brightens as it takes the new colour. Everything leans the way the choice
 * moved: toward the next card or back to an earlier one. A face takes part by what it marks: `data-deck="face"` on
 * the card, `"sheen"` and `"ghost"` on the parts that move (a face without them simply skips that part).
 *
 * The lift itself is a CSS transition (deck.css): it retargets on its own when the choice changes again. The
 * swings here are Web Animations that start and end at rest and are *added* onto whatever else runs on the card, so
 * a person flicking through the deck never makes a card jump: a card still swinging in when it is sent back simply
 * gets the new move on top of the old one, and both settle at rest. Only transform, opacity and filter move.
 */
export type Dir = -1 | 0 | 1;
/** Which way the chosen card moved along the deck: to a later card, to an earlier one, or not at all. */
export const switchDirection = (from: number, to: number): Dir => (from < 0 || to < 0 || from === to ? 0 : to > from ? 1 : -1);

type Frame = Keyframe & { translate?: string; rotate?: string; scale?: string };
const REST: Frame = { translate: '0px 0px', rotate: '0deg' };
const deg = (n: number) => `${+n.toFixed(2)}deg`;

/** The card that comes up: it rises past its place, leaning the way the deck moved, and swings back to rest. */
export function incomingFrames(dir: Dir): Frame[] {
  const d = dir || 1;
  return [
    { ...REST, easing: 'cubic-bezier(.2,.7,.3,1)' },
    { translate: '0px -7px', rotate: deg(1.8 * d), offset: 0.3, easing: 'cubic-bezier(.45,0,.35,1)' },
    { translate: '0px 2px', rotate: deg(-0.6 * d), offset: 0.62, easing: 'ease-in-out' },
    { translate: '0px 0px', rotate: deg(0.15 * d), offset: 0.84, easing: 'ease-out' },
    { ...REST },
  ];
}
/** The card it replaces: a nudge back into the deck, away from the new one, then rest. */
export function outgoingFrames(dir: Dir): Frame[] {
  const d = dir || 1;
  return [
    { ...REST, easing: 'cubic-bezier(.2,.7,.3,1)' },
    { translate: `${-6 * d}px 4px`, rotate: deg(-1.2 * d), offset: 0.35, easing: 'ease-in-out' },
    { ...REST },
  ];
}
/** The ghost on the card peeks up from below, wobbles once and sits: a replacement, it ends at the card's own look. */
export function ghostFrames(dir: Dir, rest: number): Frame[] {
  const d = dir || 1;
  return [
    { opacity: 0, translate: '0px 55%', scale: '.55', rotate: deg(-14 * d), easing: 'cubic-bezier(.2,.8,.3,1.2)' },
    { opacity: Math.min(1, rest * 1.25), translate: '0px -12%', scale: '1.1', rotate: deg(6 * d), offset: 0.55, easing: 'ease-in-out' },
    { translate: '0px 3%', scale: '.97', rotate: deg(-2 * d), offset: 0.8, easing: 'ease-out' },
    { opacity: rest, translate: '0px 0px', scale: '1', rotate: '0deg' },
  ];
}
/** A band of light crossing the card the way the deck moved. It starts and ends off the card, which clips it. */
export const sheenFrames = (dir: Dir): Frame[] => {
  const d = dir || 1;
  return [{ translate: `${-120 * d}% 0px`, opacity: 1 }, { translate: `${120 * d}% 0px`, opacity: 1 }];
};

export const TIMING = { card: 560, out: 460, ghost: 640, ghostDelay: 90, sheen: 720, sheenDelay: 70, glow: 620 } as const;

const ADD = { composite: 'add' } as const;
const face = (card: HTMLElement | null | undefined) => card?.querySelector<HTMLElement>('[data-deck=face]') ?? null;

/** Play the switch from `outgoing` to `incoming`. Nothing moves with reduced motion: the caller does not call it. */
export function playSwitch({ glow, incoming, outgoing, dir }: { glow: HTMLElement | null; incoming: HTMLElement | null; outgoing: HTMLElement | null; dir: Dir }) {
  const inFace = face(incoming), outFace = face(outgoing);
  if (!inFace || typeof inFace.animate !== 'function') return;
  inFace.animate(incomingFrames(dir), { duration: TIMING.card, ...ADD });
  outFace?.animate(outgoingFrames(dir), { duration: TIMING.out, ...ADD });

  const ghost = inFace.querySelector<HTMLElement>('[data-deck=ghost]');
  if (ghost) {
    // A ghost peeking in on a card that was chosen a moment ago and is chosen again starts over rather than doubling.
    ghost.getAnimations().forEach((a) => a.cancel());
    const rest = Number.parseFloat(getComputedStyle(ghost).opacity) || 0.3;
    ghost.animate(ghostFrames(dir, rest), { duration: TIMING.ghost, delay: TIMING.ghostDelay, easing: 'linear', fill: 'backwards' });
  }
  inFace.querySelector<HTMLElement>('[data-deck=sheen]')?.animate(sheenFrames(dir), { duration: TIMING.sheen, delay: TIMING.sheenDelay, easing: 'cubic-bezier(.35,0,.25,1)', fill: 'backwards' });
  // The glow takes the new colour by its own transition; this is the breath it takes as it does.
  glow?.animate([{ opacity: 0 }, { opacity: 0.1, offset: 0.3, easing: 'ease-out' }, { opacity: 0 }], { duration: TIMING.glow, ...ADD });
}

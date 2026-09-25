/**
 * The logo's motions (components/AppBrand.tsx): A "breathes and blinks", B "sways and looks". One plays when the app
 * opens and one each time the pointer comes over the logo; they take turns, and each ends where it started.
 * Web Animations, as the approved preview was made: an easing spans the whole motion, not each step between frames.
 */
export type BrandMotion = "breathe" | "sway";
export type BrandCue = "open" | "hover";

/** The motion that played last, kept across app opens so the next open plays the other one. The device's, not a profile's. */
export const BRAND_MOTION_KEY = "ghostly-brand-motion";

/** How long a motion keeps the logo busy: a pointer coming over it before then plays nothing. */
export const BRAND_BUSY: Record<BrandMotion, Record<BrandCue, number>> = {
  breathe: { open: 900, hover: 420 },
  sway: { open: 1650, hover: 720 },
};

let opened = false;
let lastPlayed: BrandMotion | null = null;

/** True once per launch: the chat list can mount again (StrictMode, a remount) without the app opening again. */
export function firstOpen(): boolean {
  if (opened) return false;
  opened = true;
  return true;
}

/** Whose turn it is: the other motion than last time, so the same one never plays twice in a row; "breathe" at first. */
export function takeBrandTurn(): BrandMotion {
  let last = lastPlayed;
  try { last = (localStorage.getItem(BRAND_MOTION_KEY) as BrandMotion | null) ?? last; } catch { /* no storage: turns within this launch */ }
  const next: BrandMotion = last === "breathe" ? "sway" : "breathe";
  lastPlayed = next;
  try { localStorage.setItem(BRAND_MOTION_KEY, next); } catch { /* as above */ }
  return next;
}

/** Tests: the next render is the app opening again. */
export function resetBrandLaunch(): void {
  opened = false;
  lastPlayed = null;
}

const OUT = "cubic-bezier(.22,1,.36,1)";
const blink = (delay: number): [Keyframe[], KeyframeAnimationOptions] =>
  [[{ transform: "scaleY(1)" }, { transform: "scaleY(.1)" }, { transform: "scaleY(1)" }], { duration: 160, delay, easing: "ease-in-out" }];

/** The Testnet badge's part of an opening: it fades in with A, and comes in last with B. */
export function enterBrandBadge(root: HTMLElement, motion: BrandMotion): Animation[] {
  const badge = root.querySelector<HTMLElement>(".app-brand-badge");
  if (!badge?.animate) return [];
  return [motion === "breathe"
    ? badge.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 420, fill: "backwards" })
    : badge.animate([{ opacity: 0, transform: "scale(.9)" }, { opacity: 1, transform: "scale(1)" }], { duration: 280, delay: 1000, easing: OUT, fill: "backwards" })];
}

/** Plays one motion on the logo's parts, and returns its animations. The ghost moves as a whole; the eyes in the drawing's own units. */
export function playBrandMotion(root: HTMLElement, motion: BrandMotion, cue: BrandCue): Animation[] {
  const ghost = root.querySelector<SVGSVGElement>(".app-brand-ghost");
  const eyes = root.querySelector<SVGGElement>(".app-brand-eyes");
  const letters = [...root.querySelectorAll<HTMLElement>(".app-brand-letter")];
  if (!ghost?.animate || !eyes) return [];
  // Towards the name, which is on the other side in a right-to-left layout.
  const look = `translateX(${getComputedStyle(root).direction === "rtl" ? -2.5 : 2.5}px)`;
  const glance = (duration: number, delay: number, hold: boolean) => eyes.animate(hold
    ? [{ transform: "translateX(0)" }, { transform: look, offset: 0.35 }, { transform: look, offset: 0.7 }, { transform: "translateX(0)" }]
    : [{ transform: "translateX(0)" }, { transform: look }, { transform: "translateX(0)" }], { duration, delay, easing: OUT });

  if (motion === "breathe" && cue === "open") return [
    ghost.animate([{ transform: "translateY(4px)", opacity: 0.5 }, { transform: "translateY(-1px)", opacity: 1, offset: 0.7 }, { transform: "translateY(0)", opacity: 1 }], { duration: 520, easing: OUT }),
    ...letters.map((letter, i) => letter.animate([{ opacity: 0, top: "3px" }, { opacity: 1, top: "0px" }], { duration: 320, delay: 120 + i * 28, easing: OUT, fill: "backwards" })),
    eyes.animate(...blink(560)),
    ...enterBrandBadge(root, motion),
  ];
  if (motion === "breathe") return [
    ghost.animate([{ transform: "translateY(0)" }, { transform: "translateY(-2px)" }, { transform: "translateY(0)" }], { duration: 360, easing: OUT }),
    eyes.animate(...blink(60)),
  ];
  if (cue === "open") return [
    ghost.animate(["0deg", "-6deg", "4deg", "-1.5deg", "0deg"].map((a) => ({ transform: `rotate(${a})` })), { duration: 900, easing: "ease-in-out" }),
    glance(1100, 500, true),
    ...letters.map((letter, i) => letter.animate([{ opacity: 1 }, { opacity: 0.45 }, { opacity: 1 }], { duration: 260, delay: 620 + i * 45, easing: "ease-in-out" })),
    ...enterBrandBadge(root, motion),
  ];
  return [
    ghost.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(-3deg)" }, { transform: "rotate(0deg)" }], { duration: 420, easing: "ease-in-out" }),
    glance(700, 0, false),
  ];
}

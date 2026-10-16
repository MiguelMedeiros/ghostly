import { END, START, STEPS } from "./protocolTimeline";

/** Speeds along the timeline, in timeline seconds per second. */
export const SPEED = { play: 1, back: 1.6, rewind: 3, catchUp: 4 } as const;
/** Play all: how long a finished step stays before the next, in ms. */
export const HOLD = { motion: 2800, calm: 5000 } as const;
/** A jump of more than one step: the picture fades out for this long before the target starts (DUR.fast). */
const CUT_MS = 150;

type Leg = { to: number; speed: number };

/** A shape that reads `--t`, and the stretches of the timeline over which what it shows changes. */
type Timed = { el: HTMLElement | SVGElement; spans: [number, number][] };

/**
 * The stretches over which each rule of app/dev-steps.css that reads `--t` changes; outside them it is constant. The
 * times are the shape's own (--a, --b, --d, --f), defaulting to their @property initial values. A new rule that reads
 * `--t` gets its entry here (scripts/step-clock.test.mjs checks that every one has).
 */
const SPANS: Record<string, (a: number, b: number, d: number, f: number) => [number, number][]> = {
  "sx-in": (a, _b, d) => [[a, a + d]],
  "sx-out": (_a, b, _d, f) => [[b - f, b]],
  "sx-win": (a, b, d, f) => [[a, a + d], [b - f, b]],
  "sx-dim": (a, b, d, f) => [[a, a + d], [b - f, b]],
  "sx-go": (a, _b, d) => [[a, a + d]],
  "sx-trip": (a, _b, d) => [[a, a + 0.12], [a + d - 0.12, a + d]],
  "sx-land": (a) => [[a, a + 0.12]],
  "sx-burst": (a) => [[a, a + 0.04]],
  // The connecting line's dashes march with --t all along.
  "psx-dash": () => [[-Infinity, Infinity]],
};
const TIMED_CLASSES = Object.keys(SPANS);

function timed(root: HTMLElement): Timed[] {
  const selector = TIMED_CLASSES.map((c) => `.${c}`).join(",");
  return [...root.querySelectorAll<HTMLElement | SVGElement>(selector)].map((el) => {
    const n = (name: string, fallback: number) => {
      const x = parseFloat(el.style.getPropertyValue(name));
      return Number.isFinite(x) ? x : fallback;
    };
    const [a, b, d, f] = [n("--a", 0), n("--b", 999), n("--d", 0.3), n("--f", 0.2)];
    return { el, spans: TIMED_CLASSES.filter((c) => el.classList.contains(c)).flatMap((c) => SPANS[c](a, b, d, f)) };
  });
}

/**
 * The explainer's clock: where the picture is on the timeline (`t`), the legs
 * still to travel, and the step the reader is on. While it moves it writes `--t`
 * each frame on the shapes whose picture changes between the last frame and this
 * one, and on the root element once it stops: written on the root at every frame,
 * `--t` restyled all of the explainer's elements (about 900) a frame, and a step
 * played at 21 frames a second on a 4x slower CPU. React only
 * hears about a new step, Play all starting or stopping, and the picture being
 * cut for a jump.
 *
 * Arriving at the next step plays it; going back plays the step being left in
 * reverse (a little faster); a jump fades the picture, starts the target at its
 * first frame and plays it; replay rewinds the step quickly and plays it again.
 * With reduced motion every change lands on the step's finished frame at once.
 */
export class StepClock {
  el: HTMLElement | null = null;
  calm = false;
  step = 0;
  playing = false;
  /** Whether anything has played yet: before that, the first step waits at its first frame. */
  started = false;
  private t = 0;
  /** The timeline position the shapes were last written at. */
  private shown = 0;
  private shapes: Timed[] = [];
  private legs: Leg[] = [];
  private raf = 0;
  private last = 0;
  private cutTimer = 0;
  private holdTimer = 0;
  private introTimer = 0;

  constructor(
    private readonly on: {
      step(i: number): void;
      playing(on: boolean): void;
      cut(on: boolean): void;
    },
  ) {}

  /** Mount: the picture starts at the first step's first frame (reduced motion: its finished frame). */
  attach(el: HTMLElement, calm: boolean) {
    this.el = el;
    this.shapes = timed(el);
    // The shapes inherit the root's --t until the clock first writes them.
    this.shown = parseFloat(getComputedStyle(el).getPropertyValue("--t")) || 0;
    this.setCalm(calm);
  }

  setCalm(calm: boolean) {
    this.calm = calm;
    if (calm) {
      this.legs = [];
      this.t = END[this.step];
      this.write();
    } else if (!this.started) {
      this.t = 0;
    }
  }

  /** The explainer came into view: play the first step once. */
  intro() {
    if (this.started || this.calm) return;
    this.started = true;
    this.introTimer = window.setTimeout(() => this.run([{ to: END[0], speed: SPEED.play }]), 300);
  }

  next() {
    this.stop();
    this.go(this.step + 1);
  }
  prev() {
    this.stop();
    this.go(this.step - 1);
  }
  replay() {
    this.stop();
    this.go(this.step);
  }
  jump(i: number) {
    this.stop();
    this.go(i);
  }

  /** Play all: from here to the end, a hold on each finished step; again from the start when at the end. */
  toggleAll() {
    if (this.playing) {
      this.stop();
      return;
    }
    this.setPlaying(true);
    const i = this.step;
    if (i === STEPS - 1 && this.t >= END[i] - 0.01) this.go(0);
    else if (this.t < END[i] - 0.01) this.run([{ to: END[i], speed: SPEED.play }]);
    else this.done();
  }

  detach() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.clearTimeout(this.cutTimer);
    window.clearTimeout(this.holdTimer);
    window.clearTimeout(this.introTimer);
    this.el = null;
    this.shapes = [];
  }

  private stop() {
    window.clearTimeout(this.holdTimer);
    if (this.playing) this.setPlaying(false);
  }

  private setPlaying(on: boolean) {
    this.playing = on;
    this.on.playing(on);
  }

  private go(i: number) {
    if (i < 0 || i >= STEPS) return;
    window.clearTimeout(this.cutTimer);
    window.clearTimeout(this.introTimer);
    this.on.cut(false);
    const from = this.step;
    if (i === from && this.started) {
      this.run([
        { to: START[i], speed: SPEED.rewind },
        { to: END[i], speed: SPEED.play },
      ]);
      return;
    }
    this.step = i;
    this.on.step(i);
    if (i === from + 1) {
      // Forward: finish what is still playing quickly, then play the step.
      const catchUp = this.t < START[i] - 0.01 ? [{ to: START[i], speed: SPEED.catchUp }] : [];
      this.run([...catchUp, { to: END[i], speed: SPEED.play }]);
    } else if (i === from - 1) {
      // Back: the step being left, in reverse, down to this step's finished frame.
      this.run([{ to: END[i], speed: SPEED.back }]);
    } else if (this.calm) {
      this.run([{ to: END[i], speed: SPEED.play }]);
    } else {
      // A jump: fade the picture, start the target at its first frame, fade back in and play it.
      this.legs = [];
      this.on.cut(true);
      this.cutTimer = window.setTimeout(() => {
        this.t = START[i];
        this.write(false);
        this.on.cut(false);
        this.run([{ to: END[i], speed: SPEED.play }]);
      }, CUT_MS);
    }
  }

  private run(legs: Leg[]) {
    this.started = true;
    if (this.calm) {
      this.legs = [];
      if (legs.length) this.t = legs[legs.length - 1].to;
      this.write();
      this.done();
      return;
    }
    this.legs = legs;
    if (!this.raf) {
      this.last = 0;
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  private tick = (now: number) => {
    const dt = this.last ? Math.min(now - this.last, 64) / 1000 : 0;
    this.last = now;
    let budget = dt;
    while (budget > 0 && this.legs.length) {
      const leg = this.legs[0];
      const dir = Math.sign(leg.to - this.t);
      const need = Math.abs(leg.to - this.t) / leg.speed;
      if (dir === 0 || need <= budget) {
        this.t = leg.to;
        budget -= need;
        this.legs.shift();
      } else {
        this.t += dir * leg.speed * budget;
        budget = 0;
      }
    }
    this.write(!this.legs.length);
    if (this.legs.length) this.raf = requestAnimationFrame(this.tick);
    else {
      this.raf = 0;
      this.done();
    }
  };

  /** A step finished: with Play all on, hold it, then the next; stop at the end. */
  private done() {
    if (!this.playing) return;
    window.clearTimeout(this.holdTimer);
    if (this.step >= STEPS - 1) {
      this.setPlaying(false);
      return;
    }
    this.holdTimer = window.setTimeout(() => {
      if (this.playing) this.go(this.step + 1);
    }, this.calm ? HOLD.calm : HOLD.motion);
  }

  /**
   * A shape whose spans the playhead has not crossed since it was last written shows the same picture at `t`, so it
   * keeps its value. Once the clock stops (`settled`) the root takes `t` too, for whatever reads it or mounts later.
   */
  private write(settled = true) {
    const value = this.t.toFixed(3);
    const lo = Math.min(this.shown, this.t);
    const hi = Math.max(this.shown, this.t);
    for (const { el, spans } of this.shapes) if (spans.some(([a, b]) => a <= hi && b >= lo)) el.style.setProperty("--t", value);
    this.shown = this.t;
    if (settled) this.el?.style.setProperty("--t", value);
  }
}

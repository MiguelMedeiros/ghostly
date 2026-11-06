"use client";

import { Component, useEffect } from "react";
import { useCards, usePortrait } from "./stage";

/** A step's title, in every shape of the chapter. */
const TITLE = ".scene-step > .h-scene, .scene-static-copy > .h-scene";
const STEP = ".scene-step, .scene-static-step";
const STEPS = ".scene-steps, .scene-static-steps";

/**
 * The parts of a chapter that every shape of it has (the film, the illustrated article, the phone chapter): a
 * reader looking at one of them before the chapter changes shape is looking at the same one after.
 */
const PARTS = [".scene-visual, .scene-static-figure", TITLE, STEP, STEPS, ".eyebrow"];

/**
 * One element on the way from what is at the middle of the screen up to the page, the point of it to keep (`f` of
 * the way down it) and where on the screen that point was, in a window `h` high (a window that changed height puts it
 * as far down the new one: the middle stays the middle). `el` is null for a mark kept over a reload.
 * `pinned`: it was held on screen while the page scrolled under it (the film's picture and copy, in `.scene-sticky`
 * once their chapter has reached the top), so where it is says nothing about how far into its chapter the reader
 * is: the chapter itself does.
 */
type Mark = { el: Element | null; id: string | null; f: number; at: number; h: number; home: string | null; part: string | null; i: number; pinned: boolean };

function marked(el: Element, f: number, at: number): Mark {
  const section = el.closest("section[id]");
  const part = PARTS.find((sel) => el.matches(sel)) ?? null;
  const i = section && part ? Array.prototype.indexOf.call(section.querySelectorAll(part), el) : -1;
  return { el, id: el.id || null, f, at, h: window.innerHeight, home: section?.id ?? null, part, i, pinned: false };
}

/** Whether the element holds still on screen as the page scrolls: fixed, or sticky and held away from where its
 * parent would put it (a sticky element still at the top of its parent scrolls with the page). */
function stuck(el: Element): boolean {
  const at = getComputedStyle(el).position;
  if (at === "fixed") return true;
  return at === "sticky" && !!el.parentElement && el.getBoundingClientRect().top - el.parentElement.getBoundingClientRect().top > 0.5;
}

/** Whether the element is inside one that may hold still (in the page as it is now, whatever the scroll). */
function inSticky(el: Element): boolean {
  for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
    const at = getComputedStyle(e).position;
    if (at === "sticky" || at === "fixed") return true;
  }
  return false;
}

/** What sits at the middle of the screen, from the innermost element out. None while a link to a section is still
 * taking the page there (LandOnHash): that section, not the middle of the screen, is where the reader is. */
function mark(): Mark[] | null {
  if (window.scrollY <= 0 || document.documentElement.dataset.landing) return null;
  const y = window.innerHeight / 2;
  const marks: Mark[] = [];
  let step = false;
  for (let el = document.elementFromPoint(window.innerWidth / 2, y); el && el !== document.body; el = el.parentElement) {
    if (!step && el.matches(`${STEP}, ${STEPS}`)) {
      step = true;
      // Steps take no pointer, so the middle of the screen over one finds their list: the step is the one under it.
      // It is a title over a few lines in one shape of the chapter and a title over a picture in another: the
      // reader's step is kept by where its title was, not by how far down the step the middle of the screen was.
      const title = (el.matches(STEP) ? el : nearest(el.children, y))?.querySelector(TITLE);
      if (title && !marks.some((m) => m.el === title)) marks.push(marked(title, 0, title.getBoundingClientRect().top));
    }
    if (!step && el.matches("section[id].scene") && !marks.some((m) => m.part)) {
      step = true;
      // The middle of the screen in a chapter but on none of its parts (past its last step, in its padding): the
      // chapter folds to a few lines a step before it runs and takes far more after, so a spot as far down it lands
      // elsewhere. The reader's step is the one nearest, kept by its title, ahead of what was found on the way here.
      const list = el.querySelector(STEPS);
      const title = list && nearest(list.children, y)?.querySelector(TITLE);
      if (title) marks.unshift(marked(title, 0, title.getBoundingClientRect().top));
    }
    const r = el.getBoundingClientRect();
    // A title keeps its top too: the other shape may wrap it over another number of lines.
    if (el.matches(TITLE)) marks.push(marked(el, 0, r.top));
    else marks.push(marked(el, r.height > 0 ? Math.min(1, Math.max(0, (y - r.top) / r.height)) : 0, y));
  }
  // Everything inside the outermost element that holds still holds still with it.
  let held = -1;
  marks.forEach((m, i) => {
    if (m.el && stuck(m.el)) held = i;
  });
  for (let i = 0; i <= held; i++) marks[i].pinned = true;
  return marks.length ? marks : null;
}

/** Of a list's steps, the one at screen height `y` (or the closest to it, in the gap between two). In the film the
 * steps lie on top of each other: there it is the one showing. */
function nearest(items: HTMLCollection, y: number): Element | null {
  let best: Element | null = null;
  let by = Infinity;
  for (const item of items) {
    const r = item.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < by || (d === by && item.getAttribute("data-active") === "true")) [best, by] = [item, d];
  }
  return best;
}

/** The same thing in the page as it is now: the element itself if it stayed, else its part of the chapter, else its id. */
function find(m: Mark): Element | null {
  if (m.el?.isConnected) return m.el;
  if (m.part && m.home && m.i >= 0) {
    const same = document.getElementById(m.home)?.querySelectorAll(m.part)[m.i];
    if (same) return same;
  }
  return m.id ? document.getElementById(m.id) : null;
}

/**
 * Keeps the middle of the screen in the reader's chapter. When what was at the middle is gone from the chapter's new
 * shape (a tablet turned, the figure drawn anew before the resize event), its step is held by its title where the
 * title was: above the screen, for a reader further down the step. In the shorter shape (the cards) that lands past
 * the chapter's end, on the statement after it: the reader was in the chapter, and stays in it.
 */
function inChapter(home: string | null) {
  const section = home ? document.getElementById(home) : null;
  if (!section) return;
  const r = section.getBoundingClientRect();
  const middle = window.innerHeight / 2;
  if (r.top <= middle && r.bottom > middle) return;
  // The nearest point of the chapter, a little way in from its edge, goes to the middle.
  const margin = Math.min(r.height, window.innerHeight) / 4;
  const point = Math.min(Math.max(middle, r.top + margin), r.bottom - margin);
  window.scrollBy({ top: point - middle, behavior: "instant" });
}

function hold(marks: Mark[]) {
  for (const m of marks) {
    const el = find(m);
    // An element the new size does not show (a picture for another width) has no place to hold. One that was held on
    // screen and still may be is held by its chapter; once the chapter has taken a shape that scrolls (the cards), its
    // part of the chapter is where the reader is.
    if (!el || !el.getClientRects().length || (m.pinned && inSticky(el))) continue;
    const r = el.getBoundingClientRect();
    const at = m.h > 0 ? (m.at * window.innerHeight) / m.h : m.at;
    const by = r.top + m.f * r.height - at;
    if (Math.abs(by) >= 1) window.scrollBy({ top: by, behavior: "instant" });
    inChapter(m.home);
    return;
  }
}

/** Where the reader was when the page went away (a reload, a page of another site), for this tab. */
const PLACE_KEY = "ghostly.home.place";

/** How long after the page starts a change of height still sends the reader back to their place (as LandOnHash). */
const SETTLE_MS = 4000;

const TOUCHED = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/** The place this page load takes the reader back to: undefined until read, null once there (or none). */
let place: Mark[] | null | undefined;

/**
 * On the way out, what is at the middle of the screen, by its part of the chapter (the element does not outlive the
 * page), and the browser told not to restore the offset itself: it would restore it into the server's page, whose
 * chapters have another shape and height (stage.tsx), and the reader would land elsewhere.
 */
function save() {
  // Still taking the reader back: the place kept is still theirs.
  if (place) return;
  // A wide window with a mouse has the server's page: there the offset is the reader's place, to the frame of a film.
  // Read from the head's flags (layout.tsx), as the page's own fold does: in pagehide Chromium reads `(pointer: coarse)`
  // as false on a touch screen.
  const { touch, orient } = document.documentElement.dataset;
  const served = touch === undefined && orient === undefined;
  const marks = served ? null : mark()?.filter((m) => (m.part && m.home && m.i >= 0) || m.id);
  try {
    if (!marks?.length) {
      sessionStorage.removeItem(PLACE_KEY);
      return;
    }
    sessionStorage.setItem(PLACE_KEY, JSON.stringify({ path: location.pathname, marks: marks.map((m) => ({ ...m, el: null })) }));
  } catch {
    // Without storage, the browser restores the offset as before.
    return;
  }
  history.scrollRestoration = "manual";
}

/** The place kept by `save` when this page is that page again (a reload, a step back from another site). */
function saved(): Mark[] | null {
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (history.scrollRestoration !== "manual" || (nav?.type !== "reload" && nav?.type !== "back_forward")) return null;
  try {
    const kept = JSON.parse(sessionStorage.getItem(PLACE_KEY) ?? "null") as { path?: string; marks?: Mark[] } | null;
    return kept?.path === location.pathname && Array.isArray(kept.marks) && kept.marks.length ? kept.marks : null;
  } catch {
    return null;
  }
}

/** The browser restores offsets again for the pages after this one (once it is done loading this one). */
function auto() {
  const set = () => (history.scrollRestoration = "auto");
  if (document.readyState === "complete") set();
  else window.addEventListener("load", set, { once: true });
}

/**
 * Takes the reader back to the place `save` kept, in the page as it is now, and holds it there while the page
 * settles (each change of its height, a block that rose into place); it stops the moment the reader scrolls, taps or
 * types. A reader who already did, before the page ran, stays where they went.
 */
function goBack(): () => void {
  if (place === undefined) place = saved();
  const marks = place;
  if (!marks || document.documentElement.classList.contains("landed")) {
    place = null;
    auto();
    return () => {};
  }
  const again = () => hold(marks);
  const ro = new ResizeObserver(again);
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    delete document.documentElement.dataset.landing;
    ro.disconnect();
    window.clearTimeout(timer);
    document.removeEventListener("transitionend", again);
    for (const type of TOUCHED) window.removeEventListener(type, there);
    auto();
  };
  // There, by time or by the reader: a later mount of the page (a step back inside the site) does not go back again.
  const there = () => {
    place = null;
    stop();
  };
  const timer = window.setTimeout(there, SETTLE_MS);
  // While the reader is being taken back, nothing else holds a place (mark).
  document.documentElement.dataset.landing = "1";
  for (const type of TOUCHED) window.addEventListener(type, there, { passive: true });
  document.addEventListener("transitionend", again);
  ro.observe(document.body);
  again();
  return stop;
}

/**
 * The server draws the story for a wide window with a mouse (stage.tsx), and on a phone the chapters take their
 * phone shape once the page runs: a reader who has already scrolled into the story would see it jump, the page
 * above them a different height. The same goes for a window that changes size (a tablet turned, a download bar,
 * devtools): the chapters are sized in viewport heights and the scroll stays in pixels, and the browser's own
 * scroll anchoring does not act inside them. So this notes what is at the middle of the screen whenever the page
 * scrolls, and when the window changes size, or the chapters change shape, scrolls it back to the middle (a step:
 * its title back where it was) before the browser paints. By the time either runs, the page has already been laid
 * out anew (the window's new size, and the layout script's flags that follow it), so the place is the one noted
 * before. A reader at the top stays at the top.
 *
 * A reload (or a step back from another site) would restore the reader's offset into the server's page, then hold
 * what that offset shows there, a place the reader never saw: the page keeps the reader's place by what was on screen
 * instead (save) and takes them back to it once it runs (goBack).
 */
export function KeepPlace() {
  const cards = useCards();
  const portrait = usePortrait();
  useEffect(() => {
    // Back from the browser's page cache, the page is as the reader left it: the browser may restore offsets again.
    const shown = (e: PageTransitionEvent) => {
      if (e.persisted) history.scrollRestoration = "auto";
    };
    window.addEventListener("pagehide", save);
    window.addEventListener("pageshow", shown);
    const stop = goBack();
    return () => {
      window.removeEventListener("pagehide", save);
      window.removeEventListener("pageshow", shown);
      stop();
    };
  }, []);
  return <Hold shape={`${cards}:${portrait}`} />;
}

class Hold extends Component<{ shape: string }> {
  private last: Mark[] | null = null;
  private frame = 0;
  private held = 0;
  private width = 0;

  componentDidMount() {
    this.last = mark();
    this.width = window.innerWidth;
    window.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onResize);
  }

  componentWillUnmount() {
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.held);
    window.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onResize);
  }

  // Once a frame at most, after the scroll and before any resize the next frame brings.
  private onScroll = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.last = mark();
    });
  };

  // Runs before the layout script's media queries flip its flags and before React reshapes the chapters.
  private onResize = () => {
    const turned = window.innerWidth !== this.width;
    this.width = window.innerWidth;
    // On a touch screen the height alone changes as the browser's toolbar slides in and out under a scrolling finger.
    if (this.last && (turned || !("touch" in document.documentElement.dataset))) hold(this.last);
    this.last = mark();
  };

  // The place noted before the window or the layout script's flags changed, not what is at the middle now.
  getSnapshotBeforeUpdate(prev: { shape: string }): Mark[] | null {
    return prev.shape === this.props.shape ? null : this.last;
  }

  // Each chapter takes its new shape in a commit of its own (React answers every media query listener on its own),
  // all before the next frame: the place is held in that frame, once they all have, before it paints.
  componentDidUpdate(_prev: { shape: string }, _state: unknown, marks: Mark[] | null) {
    if (!marks) return;
    // Held once the task is done with the page, not in this commit: a deck mounts at no width, measures itself in a
    // layout effect and renders again before the task ends. Held here, the page would sit a card's height off
    // between that render and the next frame, where another task may read it.
    queueMicrotask(() => hold(marks));
    if (this.held) return;
    // Some of the page sizes itself only in a later task (a deck that measures its width again as it settles): held
    // once more then, still before the browser paints, and noted anew from there.
    this.held = requestAnimationFrame(() => {
      this.held = 0;
      hold(marks);
      this.last = mark();
    });
  }

  render() {
    return null;
  }
}

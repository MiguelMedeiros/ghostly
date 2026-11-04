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

/** One element on the way from what is at the middle of the screen up to the page, the point of it to keep (`f` of
 * the way down it) and where on the screen that point was. `el` is null for a mark kept over a reload. */
type Mark = { el: Element | null; id: string | null; f: number; at: number; home: string | null; part: string | null; i: number };

function marked(el: Element, f: number, at: number): Mark {
  const section = el.closest("section[id]");
  const part = PARTS.find((sel) => el.matches(sel)) ?? null;
  const i = section && part ? Array.prototype.indexOf.call(section.querySelectorAll(part), el) : -1;
  return { el, id: el.id || null, f, at, home: section?.id ?? null, part, i };
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

function hold(marks: Mark[]) {
  for (const m of marks) {
    const el = find(m);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const by = r.top + m.f * r.height - m.at;
    if (Math.abs(by) >= 1) window.scrollBy({ top: by, behavior: "instant" });
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
 * above them a different height. In the commit that changes the shape, this notes what is at the middle of the
 * screen before the chapters change and scrolls it back to the middle (a step: its title back where it was) before
 * the browser paints. A reader at the top stays at the top.
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
  // Runs before React changes the page, in the same commit as the chapters.
  getSnapshotBeforeUpdate(prev: { shape: string }): Mark[] | null {
    return prev.shape === this.props.shape ? null : mark();
  }

  componentDidUpdate(_prev: { shape: string }, _state: unknown, marks: Mark[] | null) {
    if (!marks) return;
    // Held once the task is done with the page, not in this commit: a deck mounts at no width, measures itself in a
    // layout effect and renders again before the task ends. Held here, the page would sit a card's height off
    // between that render and the next frame, where another task may read it.
    queueMicrotask(() => hold(marks));
    // Some of the page sizes itself only in a later task (a deck that measures its width again as it settles): held
    // once more then, still before the browser paints.
    requestAnimationFrame(() => hold(marks));
  }

  render() {
    return null;
  }
}

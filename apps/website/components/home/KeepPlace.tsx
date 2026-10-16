"use client";

import { Component } from "react";
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
 * the way down it) and where on the screen that point was. */
type Mark = { el: Element; f: number; at: number; home: string | null; part: string | null; i: number };

function marked(el: Element, f: number, at: number): Mark {
  const section = el.closest("section[id]");
  const part = PARTS.find((sel) => el.matches(sel)) ?? null;
  const i = section && part ? Array.prototype.indexOf.call(section.querySelectorAll(part), el) : -1;
  return { el, f, at, home: section?.id ?? null, part, i };
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
  if (m.el.isConnected) return m.el;
  if (m.part && m.home && m.i >= 0) {
    const same = document.getElementById(m.home)?.querySelectorAll(m.part)[m.i];
    if (same) return same;
  }
  return m.el.id ? document.getElementById(m.el.id) : null;
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

/**
 * The server draws the story for a wide window with a mouse (stage.tsx), and on a phone the chapters take their
 * phone shape once the page runs: a reader who has already scrolled into the story would see it jump, the page
 * above them a different height. In the commit that changes the shape, this notes what is at the middle of the
 * screen before the chapters change and scrolls it back to the middle (a step: its title back where it was) before
 * the browser paints. A reader at the top stays at the top.
 */
export function KeepPlace() {
  const cards = useCards();
  const portrait = usePortrait();
  return <Hold shape={`${cards}:${portrait}`} />;
}

class Hold extends Component<{ shape: string }> {
  // Runs before React changes the page, in the same commit as the chapters.
  getSnapshotBeforeUpdate(prev: { shape: string }): Mark[] | null {
    return prev.shape === this.props.shape ? null : mark();
  }

  componentDidUpdate(_prev: { shape: string }, _state: unknown, marks: Mark[] | null) {
    if (!marks) return;
    hold(marks);
    // Some of the page sizes itself only after this commit (a deck measures its width as it mounts, and renders
    // again): held once more when that is done, still before the browser paints.
    requestAnimationFrame(() => hold(marks));
  }

  render() {
    return null;
  }
}

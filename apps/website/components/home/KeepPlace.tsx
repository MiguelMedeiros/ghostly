"use client";

import { Component } from "react";
import { useCards, usePortrait } from "./stage";

/**
 * The parts of a chapter that every shape of it has (the film, the illustrated article, the phone chapter): a
 * reader looking at one of them before the chapter changes shape is looking at the same one after. (The steps
 * take no pointer, so the middle of the screen over a step finds their list.)
 */
const PARTS = [".scene-visual, .scene-static-figure", ".scene-step, .scene-static-step", ".scene-steps, .scene-static-steps", ".eyebrow"];

/** One element on the way from what is at the middle of the screen up to the page, and how far down it the middle was. */
type Mark = { el: Element; f: number; home: string | null; part: string | null; i: number };

/** What sits at the middle of the screen, from the innermost element out. None while a link to a section is still
 * taking the page there (LandOnHash): that section, not the middle of the screen, is where the reader is. */
function mark(): Mark[] | null {
  if (window.scrollY <= 0 || document.documentElement.dataset.landing) return null;
  const y = window.innerHeight / 2;
  const marks: Mark[] = [];
  for (let el = document.elementFromPoint(window.innerWidth / 2, y); el && el !== document.body; el = el.parentElement) {
    const r = el.getBoundingClientRect();
    const f = r.height > 0 ? Math.min(1, Math.max(0, (y - r.top) / r.height)) : 0;
    const section = el.closest("section[id]");
    const part = PARTS.find((sel) => el!.matches(sel)) ?? null;
    const i = section && part ? Array.prototype.indexOf.call(section.querySelectorAll(part), el) : -1;
    marks.push({ el, f, home: section?.id ?? null, part, i });
  }
  return marks.length ? marks : null;
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
  const y = window.innerHeight / 2;
  for (const m of marks) {
    const el = find(m);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const by = r.top + m.f * r.height - y;
    if (Math.abs(by) >= 1) window.scrollBy({ top: by, behavior: "instant" });
    return;
  }
}

/**
 * The server draws the story for a wide window with a mouse (stage.tsx), and on a phone the chapters take their
 * phone shape once the page runs: a reader who has already scrolled into the story would see it jump, the page
 * above them a different height. In the commit that changes the shape, this notes what is at the middle of the
 * screen before the chapters change and scrolls it back to the middle before the browser paints. A reader at the
 * top stays at the top.
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

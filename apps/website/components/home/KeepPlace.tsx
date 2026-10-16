"use client";

import { Component } from "react";
import { useCards, usePortrait } from "./stage";

/**
 * The parts of a chapter that every shape of it has (the film, the illustrated article, the phone chapter): a
 * reader looking at one of them before the chapter changes shape is looking at the same one after. (The steps
 * take no pointer, so the middle of the screen over a step finds their list.)
 */
const PARTS = [".scene-visual, .scene-static-figure", ".scene-step, .scene-static-step", ".scene-steps, .scene-static-steps", ".eyebrow"];

/**
 * One element on the way from what is at the middle of the screen up to the page, and how far down it the middle was.
 * `pinned`: it was held on screen while the page scrolled under it (the film's picture and copy, in `.scene-sticky`
 * once their chapter has reached the top), so where it is says nothing about how far into its chapter the reader
 * is: the chapter itself does.
 */
type Mark = { el: Element; f: number; home: string | null; part: string | null; i: number; pinned: boolean };

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
  for (let el = document.elementFromPoint(window.innerWidth / 2, y); el && el !== document.body; el = el.parentElement) {
    const r = el.getBoundingClientRect();
    const f = r.height > 0 ? Math.min(1, Math.max(0, (y - r.top) / r.height)) : 0;
    const section = el.closest("section[id]");
    const part = PARTS.find((sel) => el!.matches(sel)) ?? null;
    const i = section && part ? Array.prototype.indexOf.call(section.querySelectorAll(part), el) : -1;
    marks.push({ el, f, home: section?.id ?? null, part, i, pinned: false });
  }
  // Everything inside the outermost element that holds still holds still with it.
  let held = -1;
  marks.forEach((m, i) => {
    if (stuck(m.el)) held = i;
  });
  for (let i = 0; i <= held; i++) marks[i].pinned = true;
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
    // An element the new size does not show (a picture for another width) has no place to hold. One that was held on
    // screen and still may be is held by its chapter; once the chapter has taken a shape that scrolls (the cards), its
    // part of the chapter is where the reader is.
    if (!el || !el.getClientRects().length || (m.pinned && inSticky(el))) continue;
    const r = el.getBoundingClientRect();
    const by = r.top + m.f * r.height - y;
    if (Math.abs(by) >= 1) window.scrollBy({ top: by, behavior: "instant" });
    return;
  }
}

/**
 * The server draws the story for a wide window with a mouse (stage.tsx), and on a phone the chapters take their
 * phone shape once the page runs: a reader who has already scrolled into the story would see it jump, the page
 * above them a different height. The same goes for a window that changes size (a tablet turned, a download bar,
 * devtools): the chapters are sized in viewport heights and the scroll stays in pixels, and the browser's own
 * scroll anchoring does not act inside them. So this notes what is at the middle of the screen whenever the page
 * scrolls, and when the window changes size, or the chapters change shape, scrolls it back to the middle before
 * the browser paints. By the time either runs, the page has already been laid out anew (the window's new size,
 * and the layout script's flags that follow it), so the place is the one noted before. A reader at the top stays at
 * the top.
 */
export function KeepPlace() {
  const cards = useCards();
  const portrait = usePortrait();
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
    if (!marks || this.held) return;
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

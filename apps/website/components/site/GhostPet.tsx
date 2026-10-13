"use client";

import { useEffect, useRef, useState } from "react";
import { GHOST_PATH } from "@/components/ghost/Ghost";

type Mood = "sleeping" | "bored" | "happy" | "tired";

/* How long the ghost takes to close most of the distance to the pointer, per mood (seconds). */
const TAU: Record<Mood, number> = { happy: 2.1, bored: 2.1, tired: 4.1, sleeping: 8.3 };

/* Below this speed (px a second, a twentieth of a pixel a frame at 60 Hz) the ghost has settled and its clock stops. */
const SETTLE = 3;

/* The sleeping z's (x, y, font size, colour in the ghost's 80x100 box), each in its own box so it floats as HTML. */
const ZS: [number, number, number, string][] = [
  [62, 24, 12, "rgba(34,211,238,0.8)"],
  [68, 16, 10, "rgba(34,211,238,0.6)"],
  [72, 10, 8, "rgba(34,211,238,0.4)"],
];

/**
 * The little ghost from the original site: it trails the pointer, gets bored,
 * falls asleep when you stop moving and ducks away if you reach for it.
 * Kept as it was; it now stays home on touch screens, with reduced motion,
 * and while the tab is hidden. Its position is written straight to the DOM as
 * a transform (no render and no page layout per frame), the page size is
 * measured on resize instead of every frame, its easing is in time (the same
 * at 60 and 120 Hz), and it stops its clock once it has settled until the
 * pointer moves again or its next mood is due.
 */
export function GhostPet({ label = "Hide the ghost" }: { label?: string }) {
  const [enabled, setEnabled] = useState(false);
  const [visible, setVisible] = useState(true);
  const [mood, setMood] = useState<Mood>("sleeping");
  const [direction, setDirection] = useState<"left" | "right">("right");
  const [hiding, setHiding] = useState(false);

  const el = useRef<HTMLDivElement>(null);
  const mouse = useRef({ x: 200, y: 200 });
  const lastMove = useRef(0);
  const speed = useRef(0);
  const lastClient = useRef({ x: 0, y: 0 });
  const current = useRef({ x: 100, y: 100 });
  const bounds = useRef({ w: 0, h: 0 });
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hidingRef = useRef(false);
  const moodRef = useRef<Mood>("sleeping");
  const directionRef = useRef<"left" | "right">("right");

  useEffect(() => {
    const pointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setEnabled(pointer.matches && !calm.matches);
    update();
    pointer.addEventListener("change", update);
    calm.addEventListener("change", update);
    lastMove.current = performance.now();
    return () => {
      pointer.removeEventListener("change", update);
      calm.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    if (!enabled || !visible) return;
    let frame = 0;
    let last = 0;
    let moodTimer: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      bounds.current = { w: Math.max(document.body.scrollWidth, window.innerWidth) - 46, h: Math.max(document.body.scrollHeight, window.innerHeight) - 55 };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener("resize", measure);

    const place = () => {
      const node = el.current;
      if (!node) return;
      node.style.transform = `translate3d(${current.current.x}px, ${current.current.y}px, 0)`;
    };

    const tick = (now: number) => {
      frame = 0;
      if (document.hidden) {
        frame = requestAnimationFrame(tick);
        return;
      }
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
      last = now;
      const idle = now - lastMove.current;
      // Its spot beside the pointer, kept on the page: past an edge it would chase a point it never reaches, and its
      // clock would never stop.
      const dx = Math.max(0, Math.min(bounds.current.w, mouse.current.x + 50)) - current.current.x;
      const dy = Math.max(0, Math.min(bounds.current.h, mouse.current.y + 30)) - current.current.y;
      const cx = current.current.x + 18;
      const cy = current.current.y + 22;
      const near = Math.hypot(mouse.current.x - cx, mouse.current.y - cy) < 60;
      if (near && !hidingRef.current) {
        hidingRef.current = true;
        setHiding(true);
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => {
          hidingRef.current = false;
          setHiding(false);
        }, 1200);
      }
      const next: Mood = idle > 4000 ? "sleeping" : idle > 2000 ? "bored" : speed.current > 1 ? "tired" : "happy";
      if (next !== moodRef.current) {
        moodRef.current = next;
        setMood(next);
      }
      // Exponential approach in time: the same glide at any frame rate.
      const k = 1 - Math.exp(-dt / TAU[next]);
      const x = Math.max(0, Math.min(bounds.current.w, current.current.x + dx * k));
      const y = Math.max(0, Math.min(bounds.current.h, current.current.y + dy * k));
      current.current = { x, y };
      place();
      const dir = dx > 5 ? "right" : dx < -5 ? "left" : directionRef.current;
      if (dir !== directionRef.current) {
        directionRef.current = dir;
        setDirection(dir);
      }
      // Settled: let the clock stop until the pointer moves, or until the next mood is due. Waiting for the last half
      // pixel at the sleeping pace kept it running 45-57 s after every stop of the pointer.
      if (Math.hypot(dx, dy) / TAU[next] < SETTLE) {
        if (next !== "sleeping") moodTimer = setTimeout(wake, (idle > 2000 ? 4000 : 2000) - idle + 1);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    const wake = () => {
      if (moodTimer) clearTimeout(moodTimer);
      moodTimer = null;
      if (!frame) {
        last = 0;
        frame = requestAnimationFrame(tick);
      }
    };
    const onMove = (e: MouseEvent) => {
      const now = performance.now();
      const dt = now - lastMove.current;
      if (dt > 0) {
        const mx = e.clientX - lastClient.current.x;
        const my = e.clientY - lastClient.current.y;
        speed.current = Math.hypot(mx, my) / dt;
      }
      lastClient.current = { x: e.clientX, y: e.clientY };
      mouse.current = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
      lastMove.current = now;
      wake();
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    place();
    wake();
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("resize", measure);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (moodTimer) clearTimeout(moodTimer);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [enabled, visible]);

  if (!enabled || !visible) return null;

  return (
    // The outer box's transform is its position, written by the frame loop (place), never by a render.
    <div ref={el} className="pet" data-mood={mood}>
      <div
        className="pet-look"
        style={{
          transform: `scaleX(${direction === "left" ? -1 : 1}) ${hiding ? "scale(0.2)" : "scale(1)"}`,
          opacity: hiding ? 0 : 0.2,
        }}
      >
        {/* The loops (its float, the z's) run on HTML boxes: a CSS animation on an SVG element lays the page out at
            every frame for as long as the ghost is on screen. */}
        <div className="pet-body">
          <svg width="36" height="45" viewBox="0 0 80 100" aria-hidden="true">
            <path
              d={GHOST_PATH}
              fill="#22d3ee"
              style={{ filter: "drop-shadow(0 0 3px #22d3ee)" }}
            />
            {mood === "sleeping" && (
              <g>
                <path d="M24 36 Q29 34 34 36" stroke="#0f172a" strokeWidth="3" fill="none" strokeLinecap="round" />
                <path d="M46 36 Q51 34 56 36" stroke="#0f172a" strokeWidth="3" fill="none" strokeLinecap="round" />
              </g>
            )}
            {(mood === "bored" || mood === "happy") && (
              <g>
                <circle cx="29" cy="36" r={mood === "happy" ? 6 : 5} fill="#0f172a" />
                <circle cx="51" cy="36" r={mood === "happy" ? 6 : 5} fill="#0f172a" />
                <circle cx="30" cy="34" r={mood === "happy" ? 2 : 1.5} fill="white" />
                <circle cx="52" cy="34" r={mood === "happy" ? 2 : 1.5} fill="white" />
              </g>
            )}
            {mood === "tired" && (
              <g>
                <path d="M22 32 L36 36" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" />
                <path d="M44 36 L58 32" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" />
                <circle cx="29" cy="40" r="4" fill="#0f172a" />
                <circle cx="51" cy="40" r="4" fill="#0f172a" />
                <circle cx="30" cy="38" r="1.5" fill="white" />
                <circle cx="52" cy="38" r="1.5" fill="white" />
              </g>
            )}
          </svg>
          {mood === "sleeping" &&
            ZS.map(([x, y, size, fill], i) => (
              <span key={i} className="pet-z" style={{ animationDelay: `${i * 0.3}s` }}>
                <svg width="36" height="45" viewBox="0 0 80 100" aria-hidden="true">
                  <text x={x} y={y} fontSize={size} fill={fill}>z</text>
                </svg>
              </span>
            ))}
        </div>
        <button type="button" className="pet-hide" tabIndex={-1} onClick={() => setVisible(false)} aria-label={label}>
          ×
        </button>
      </div>
    </div>
  );
}

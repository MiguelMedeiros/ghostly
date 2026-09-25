"use client";

import { useEffect, useRef, useState } from "react";

type Mood = "sleeping" | "bored" | "happy" | "tired";

/* How long the ghost takes to close most of the distance to the pointer, per mood (seconds). */
const TAU: Record<Mood, number> = { happy: 2.1, bored: 2.1, tired: 4.1, sleeping: 8.3 };

/**
 * The little ghost from the original site: it trails the pointer, gets bored,
 * falls asleep when you stop moving and ducks away if you reach for it.
 * Kept as it was; it now stays home on touch screens, with reduced motion,
 * and while the tab is hidden. Its position is written straight to the DOM
 * (no render per frame), the page size is measured on resize instead of every
 * frame, its easing is in time (the same at 60 and 120 Hz), and it stops its
 * clock once it is asleep and settled until the pointer moves again.
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
      node.style.left = `${current.current.x}px`;
      node.style.top = `${current.current.y}px`;
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
      const dx = mouse.current.x + 50 - current.current.x;
      const dy = mouse.current.y + 30 - current.current.y;
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
      // Asleep and settled: let the clock stop until the pointer moves.
      if (next === "sleeping" && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      frame = requestAnimationFrame(tick);
    };
    const wake = () => {
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
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [enabled, visible]);

  if (!enabled || !visible) return null;

  return (
    <div
      ref={el}
      className="pet"
      data-mood={mood}
      // left/top are written by the frame loop (place), never by a render.
      style={{
        transform: `scaleX(${direction === "left" ? -1 : 1}) ${hiding ? "scale(0.2)" : "scale(1)"}`,
        opacity: hiding ? 0 : 0.2,
      }}
    >
      <svg width="36" height="45" viewBox="0 0 80 100" aria-hidden="true" className="pet-body">
        <path
          d="M40 8 C18 8 8 22 8 40 L8 72 L16 64 L24 72 L32 64 L40 72 L48 64 L56 72 L64 64 L72 72 L72 40 C72 22 62 8 40 8Z"
          fill="#22d3ee"
          style={{ filter: "drop-shadow(0 0 3px #22d3ee)" }}
        />
        {mood === "sleeping" && (
          <g>
            <path d="M24 36 Q29 34 34 36" stroke="#0f172a" strokeWidth="3" fill="none" strokeLinecap="round" />
            <path d="M46 36 Q51 34 56 36" stroke="#0f172a" strokeWidth="3" fill="none" strokeLinecap="round" />
            <text x="62" y="24" fontSize="12" fill="rgba(34,211,238,0.8)" className="pet-z">z</text>
            <text x="68" y="16" fontSize="10" fill="rgba(34,211,238,0.6)" className="pet-z" style={{ animationDelay: "0.3s" }}>z</text>
            <text x="72" y="10" fontSize="8" fill="rgba(34,211,238,0.4)" className="pet-z" style={{ animationDelay: "0.6s" }}>z</text>
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
      <button type="button" className="pet-hide" tabIndex={-1} onClick={() => setVisible(false)} aria-label={label}>
        ×
      </button>
    </div>
  );
}

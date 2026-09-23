"use client";

import { AnimatePresence, motion, useInView } from "motion/react";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { GhostGlyph } from "./icons";
import { useHaunting } from "./HauntedPage";

// The original Boo and Casper artwork, expressions, blinks and floating motion.
function GhostCharacter({
  color,
  delay,
  expression = "happy",
  isTalking = false,
  isScaring = false,
}: {
  color: "cyan" | "green";
  delay: number;
  expression?: "happy" | "wink" | "surprised";
  isTalking?: boolean;
  isScaring?: boolean;
}) {
  const { enabled } = useHaunting();
  const glowId = useId();
  const colorClass = color === "cyan" ? "text-cyan" : "text-green";
  const fillColor = color === "cyan" ? "#22d3ee" : "#4ade80";

  if (!enabled)
    return (
      <svg width="100" height="125" viewBox="0 0 80 100" aria-hidden="true">
        <path
          d="M40 8 C18 8 8 22 8 40 L8 72 L16 64 L24 72 L32 64 L40 72 L48 64 L56 72 L64 64 L72 72 L72 40 C72 22 62 8 40 8Z"
          fill={fillColor}
        />
        <circle cx="29" cy="36" r="6" fill="#0f172a" />
        <circle cx="51" cy="36" r="6" fill="#0f172a" />
        <circle cx="30" cy="34" r="2" fill="white" />
        <circle cx="52" cy="34" r="2" fill="white" />
        <path
          d="M32 50 Q40 58 48 50"
          stroke="#0f172a"
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
    );
  return (
    <motion.div
      className="flex flex-col items-center"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5 }}
    >
      <motion.div
        animate={
          isScaring
            ? {
                y: [0, -8, 0],
                opacity: [1, 0.6, 1, 0.8, 1],
                x: [-2, 2, -2, 2, -1, 1, 0],
                rotate: [-2, 2, -2, 2, -1, 1, 0],
                scale: [1, 1.1, 1, 1.08, 1],
              }
            : {
                y: [0, -8, 0],
                opacity: [1, 0.7, 1, 0.85, 1],
              }
        }
        transition={
          isScaring
            ? {
                y: {
                  duration: color === "green" ? 3.5 : 2.8,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: color === "green" ? 1.2 : 0,
                },
                opacity: {
                  duration: color === "green" ? 4.5 : 5,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: color === "green" ? 2 : 0,
                },
                x: { duration: 0.3, repeat: Infinity, ease: "easeInOut" },
                rotate: { duration: 0.3, repeat: Infinity, ease: "easeInOut" },
                scale: { duration: 0.5, repeat: Infinity, ease: "easeInOut" },
              }
            : {
                y: {
                  duration: color === "green" ? 3.5 : 2.8,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: color === "green" ? 1.2 : 0,
                },
                opacity: {
                  duration: color === "green" ? 4.5 : 5,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: color === "green" ? 2 : 0,
                },
              }
        }
      >
        <svg
          width="100"
          height="125"
          viewBox="0 0 80 100"
          className={colorClass}
        >
          <defs>
            <filter id={glowId}>
              <feGaussianBlur stdDeviation="3" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <path
            d="M40 8 C18 8 8 22 8 40 L8 72 L16 64 L24 72 L32 64 L40 72 L48 64 L56 72 L64 64 L72 72 L72 40 C72 22 62 8 40 8Z"
            fill={fillColor}
            filter={`url(#${glowId})`}
          />
          {expression === "happy" && (
            <>
              <motion.ellipse
                cx="29"
                cy="36"
                rx="6"
                fill="#0f172a"
                animate={{ ry: [6, 6, 6, 6, 6, 6, 6, 6, 6, 1, 6] }}
                transition={{
                  duration: color === "green" ? 3.5 : 3,
                  repeat: Infinity,
                  times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1],
                  delay: color === "green" ? 1.5 : 0,
                }}
              />
              <motion.ellipse
                cx="51"
                cy="36"
                rx="6"
                fill="#0f172a"
                animate={{ ry: [6, 6, 6, 6, 6, 6, 6, 6, 6, 1, 6] }}
                transition={{
                  duration: color === "green" ? 3.5 : 3,
                  repeat: Infinity,
                  times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1],
                  delay: color === "green" ? 1.5 : 0,
                }}
              />
              <motion.circle
                cy="34"
                r="2"
                fill="white"
                animate={{
                  cx: [30, 30, 32, 30, 28, 30, 30],
                  opacity: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1],
                }}
                transition={{
                  cx: {
                    duration: color === "green" ? 4 : 3.5,
                    repeat: Infinity,
                    ease: "easeInOut",
                    delay: color === "green" ? 0.5 : 0,
                  },
                  opacity: {
                    duration: color === "green" ? 3.5 : 3,
                    repeat: Infinity,
                    times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1],
                    delay: color === "green" ? 1.5 : 0,
                  },
                }}
              />
              <motion.circle
                cy="34"
                r="2"
                fill="white"
                animate={{
                  cx: [52, 52, 54, 52, 50, 52, 52],
                  opacity: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1],
                }}
                transition={{
                  cx: {
                    duration: color === "green" ? 4 : 3.5,
                    repeat: Infinity,
                    ease: "easeInOut",
                    delay: color === "green" ? 0.5 : 0,
                  },
                  opacity: {
                    duration: color === "green" ? 3.5 : 3,
                    repeat: Infinity,
                    times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1],
                    delay: color === "green" ? 1.5 : 0,
                  },
                }}
              />
              {isTalking ? (
                <motion.ellipse
                  cx="40"
                  cy="52"
                  rx="5"
                  fill="#0f172a"
                  animate={{ ry: [4, 7, 4, 6, 4] }}
                  transition={{
                    duration: 0.5,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                />
              ) : (
                <path
                  d="M32 50 Q40 58 48 50"
                  stroke="#0f172a"
                  strokeWidth="3"
                  fill="none"
                  strokeLinecap="round"
                />
              )}
            </>
          )}
          {expression === "wink" && (
            <>
              <motion.ellipse
                cx="29"
                cy="36"
                rx="6"
                fill="#0f172a"
                animate={{ ry: [6, 6, 6, 6, 6, 6, 6, 6, 6, 1, 6] }}
                transition={{
                  duration: color === "green" ? 3.5 : 3,
                  repeat: Infinity,
                  times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1],
                  delay: color === "green" ? 1.5 : 0,
                }}
              />
              <path
                d="M46 36 Q51 34 56 36"
                stroke="#0f172a"
                strokeWidth="3"
                fill="none"
                strokeLinecap="round"
              />
              <motion.circle
                cy="34"
                r="2"
                fill="white"
                animate={{
                  cx: [30, 30, 32, 30, 28, 30, 30],
                  opacity: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1],
                }}
                transition={{
                  cx: {
                    duration: color === "green" ? 4 : 3.5,
                    repeat: Infinity,
                    ease: "easeInOut",
                    delay: color === "green" ? 0.5 : 0,
                  },
                  opacity: {
                    duration: color === "green" ? 3.5 : 3,
                    repeat: Infinity,
                    times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1],
                    delay: color === "green" ? 1.5 : 0,
                  },
                }}
              />
              {isTalking ? (
                <motion.ellipse
                  cx="40"
                  cy="52"
                  rx="5"
                  fill="#0f172a"
                  animate={{ ry: [4, 7, 4, 6, 4] }}
                  transition={{
                    duration: 0.5,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                />
              ) : (
                <path
                  d="M32 50 Q40 58 48 50"
                  stroke="#0f172a"
                  strokeWidth="3"
                  fill="none"
                  strokeLinecap="round"
                />
              )}
            </>
          )}
          {expression === "surprised" && (
            <>
              <motion.ellipse
                cx="29"
                cy="36"
                rx="7"
                fill="#0f172a"
                animate={{ ry: [7, 7, 7, 7, 7, 7, 7, 7, 7, 1, 7] }}
                transition={{
                  duration: color === "green" ? 3.5 : 3,
                  repeat: Infinity,
                  times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1],
                  delay: color === "green" ? 1.5 : 0,
                }}
              />
              <motion.ellipse
                cx="51"
                cy="36"
                rx="7"
                fill="#0f172a"
                animate={{ ry: [7, 7, 7, 7, 7, 7, 7, 7, 7, 1, 7] }}
                transition={{
                  duration: color === "green" ? 3.5 : 3,
                  repeat: Infinity,
                  times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1],
                  delay: color === "green" ? 1.5 : 0,
                }}
              />
              <motion.circle
                cy="34"
                r="2.5"
                fill="white"
                animate={{
                  cx: [30, 30, 32, 30, 28, 30, 30],
                  opacity: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1],
                }}
                transition={{
                  cx: {
                    duration: color === "green" ? 4 : 3.5,
                    repeat: Infinity,
                    ease: "easeInOut",
                    delay: color === "green" ? 0.5 : 0,
                  },
                  opacity: {
                    duration: color === "green" ? 3.5 : 3,
                    repeat: Infinity,
                    times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1],
                    delay: color === "green" ? 1.5 : 0,
                  },
                }}
              />
              <motion.circle
                cy="34"
                r="2.5"
                fill="white"
                animate={{
                  cx: [52, 52, 54, 52, 50, 52, 52],
                  opacity: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1],
                }}
                transition={{
                  cx: {
                    duration: color === "green" ? 4 : 3.5,
                    repeat: Infinity,
                    ease: "easeInOut",
                    delay: color === "green" ? 0.5 : 0,
                  },
                  opacity: {
                    duration: color === "green" ? 3.5 : 3,
                    repeat: Infinity,
                    times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1],
                    delay: color === "green" ? 1.5 : 0,
                  },
                }}
              />
              {isTalking ? (
                <motion.ellipse
                  cx="40"
                  cy="54"
                  rx="6"
                  fill="#0f172a"
                  animate={{ ry: [5, 9, 5, 7, 5] }}
                  transition={{
                    duration: 0.5,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                />
              ) : (
                <ellipse cx="40" cy="54" rx="6" ry="8" fill="#0f172a" />
              )}
            </>
          )}
        </svg>
      </motion.div>
    </motion.div>
  );
}

const conversation = [
  { left: "Boo! 👻", right: "Oh, it’s you.", mood: "happy" },
  {
    left: "Wanna see my app?",
    right: "It’s on your localhost…",
    mood: "surprised",
  },
  {
    left: "Open it through Ghostly.",
    right: "Wait. I can use it?!",
    mood: "surprised",
  },
  { left: "Yep. While I’m online.", right: "Here, 21 sats ⚡", mood: "wink" },
  {
    left: "Sent you the files, too.",
    right: "Got them. Jump on a call?",
    mood: "happy",
  },
  { left: "Camera or screen?", right: "Surprise me, ghost. 👻", mood: "wink" },
] as const;

const introduction = [
  { left: "Boo! 👻", right: "Oh, it’s you.", mood: "happy" },
  { left: "Sent you a photo.", right: "Got it!", mood: "happy" },
  { left: "A little thank-you?", right: "21 sats ⚡", mood: "wink" },
] as const;

export function GhostConversation({ intro = false }: { intro?: boolean }) {
  const lines = intro ? introduction : conversation;
  const [step, setStep] = useState(0);
  const { enabled } = useHaunting();
  const scene = useRef<HTMLDivElement>(null);
  const visible = useInView(scene, { amount: 0.3 });
  useEffect(() => {
    if (!enabled || !visible) return;
    const timer = window.setInterval(
      () => setStep((value) => (value + 1) % lines.length),
      4200,
    );
    return () => window.clearInterval(timer);
  }, [enabled, visible, lines.length]);
  const current = lines[step];

  return (
    <div className="ghost-conversation" ref={scene}>
      <div
        className="ghost-duo"
        aria-label="Boo and Casper illustrate what Ghostly can do"
      >
        <div className="ghost-speaker boo">
          <div className="ghost-bubble-slot">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={step}
                className="ghost-bubble"
                initial={enabled ? { opacity: 0, y: 12, scale: 0.9 } : false}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: enabled ? 0.25 : 0 }}
              >
                {current.left}
              </motion.div>
            </AnimatePresence>
          </div>
          <GhostCharacter
            color="cyan"
            delay={0.1}
            expression="happy"
            isTalking
            isScaring={step === 0}
          />
          <span className="ghost-name">Boo</span>
        </div>
        <div className="ghost-link" aria-hidden="true">
          <span />
          <i />
          <i />
          <i />
          <span />
        </div>
        <div className="ghost-speaker casper">
          <div className="ghost-bubble-slot">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={step}
                className="ghost-bubble"
                initial={enabled ? { opacity: 0, y: 12, scale: 0.9 } : false}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{
                  duration: enabled ? 0.25 : 0,
                  delay: enabled ? 0.12 : 0,
                }}
              >
                {current.right}
              </motion.div>
            </AnimatePresence>
          </div>
          <GhostCharacter
            color="green"
            delay={0.2}
            expression={current.mood}
            isTalking
          />
          <span className="ghost-name">Casper</span>
        </div>
      </div>
      <div
        className="ghost-story-controls"
        role="group"
        aria-label="Ghost conversation scenes"
      >
        {lines.map((line, index) => (
          <button
            key={line.left}
            type="button"
            onClick={() => setStep(index)}
            aria-label={`Scene ${index + 1}: ${line.left}`}
            aria-pressed={step === index}
          >
            <span />
          </button>
        ))}
      </div>
    </div>
  );
}

// Deterministic positions keep the server and client markup identical.
const particles = Array.from({ length: 18 }, (_, index) => ({
  x: (index * 47 + 5) % 100,
  y: (index * 31 + 8) % 96,
  size: 18 + ((index * 13) % 36),
  delay: -((index * 7) % 17),
  duration: 12 + ((index * 3) % 14),
}));

export function GhostParticles() {
  return (
    <div className="ghost-particles" aria-hidden="true">
      {particles.map((ghost, index) => (
        <span
          key={index}
          style={
            {
              left: `${ghost.x}%`,
              top: `${ghost.y}%`,
              width: ghost.size,
              height: ghost.size,
              "--drift-delay": `${ghost.delay}s`,
              "--drift-duration": `${ghost.duration}s`,
            } as CSSProperties
          }
        >
          <GhostGlyph className="w-full h-full" />
        </span>
      ))}
    </div>
  );
}

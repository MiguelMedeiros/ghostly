"use client";

import { motion, AnimatePresence } from "motion/react";
import { useEffect, useState } from "react";

const title = "Ghostly";

const taglines = [
  "Ephemeral by design",
  "Your messages, your rules",
  "No servers. No traces.",
  "Privacy without compromise",
  "Truly decentralized chat",
];

function GhostIcon({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/>
      <circle cx="9" cy="9" r="1.5" fill="currentColor" className="text-background"/>
      <circle cx="15" cy="9" r="1.5" fill="currentColor" className="text-background"/>
    </svg>
  );
}

function FloatingGhost({ 
  delay, 
  duration, 
  size, 
  x, 
  y, 
  opacity 
}: { 
  delay: number; 
  duration: number; 
  size: number; 
  x: number; 
  y: number; 
  opacity: number;
}) {
  return (
    <motion.div
      className="absolute pointer-events-none text-cyan"
      style={{ 
        left: `${x}%`, 
        top: `${y}%`,
        width: size,
        height: size,
        filter: size > 40 ? 'blur(1px)' : 'none',
      }}
      initial={{ opacity: 0, y: 20 }}
      animate={{ 
        opacity: [0, opacity, opacity, 0],
        y: [20, 0, -30, -60],
        x: [0, 10, -10, 0],
        rotate: [0, 5, -5, 0],
      }}
      transition={{
        duration,
        delay,
        repeat: Infinity,
        ease: "easeInOut",
      }}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
        <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/>
        <circle cx="9" cy="9" r="1.5" className="fill-background"/>
        <circle cx="15" cy="9" r="1.5" className="fill-background"/>
      </svg>
    </motion.div>
  );
}

function GhostParticles() {
  const [ghosts, setGhosts] = useState<Array<{
    id: number;
    x: number;
    y: number;
    size: number;
    delay: number;
    duration: number;
    opacity: number;
  }>>([]);

  useEffect(() => {
    setGhosts(
      Array.from({ length: 25 }, (_, i) => ({
        id: i,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: 20 + Math.random() * 50,
        delay: Math.random() * 10,
        duration: 8 + Math.random() * 10,
        opacity: 0.06 + Math.random() * 0.12,
      }))
    );
  }, []);

  if (ghosts.length === 0) return null;

  return (
    <div className="absolute inset-0 overflow-hidden">
      {ghosts.map((ghost) => (
        <FloatingGhost key={ghost.id} {...ghost} />
      ))}
    </div>
  );
}

function ChatBubble({ 
  children, 
  side,
}: { 
  children: React.ReactNode; 
  side: "left" | "right"; 
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.8, y: -10 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={`relative whitespace-nowrap px-4 py-2.5 rounded-2xl text-sm ${
        side === "left" 
          ? "bg-cyan/20 text-cyan rounded-bl-sm" 
          : "bg-green/20 text-green rounded-br-sm"
      }`}
    >
      {children}
      <div
        className={`absolute -bottom-1 ${side === "left" ? "left-2" : "right-2"} w-3 h-3 rotate-45 ${
          side === "left" ? "bg-cyan/20" : "bg-green/20"
        }`}
      />
    </motion.div>
  );
}

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
  const colorClass = color === "cyan" ? "text-cyan" : "text-green";
  const fillColor = color === "cyan" ? "#22d3ee" : "#4ade80";
  
  return (
    <motion.div 
      className="flex flex-col items-center"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5 }}
    >
      <motion.div
        animate={isScaring ? { 
          y: [0, -8, 0],
          opacity: [1, 0.6, 1, 0.8, 1],
          x: [-2, 2, -2, 2, -1, 1, 0],
          rotate: [-2, 2, -2, 2, -1, 1, 0],
          scale: [1, 1.1, 1, 1.08, 1],
        } : { 
          y: [0, -8, 0],
          opacity: [1, 0.7, 1, 0.85, 1],
        }}
        transition={isScaring ? { 
          y: { duration: color === "green" ? 3.5 : 2.8, repeat: Infinity, ease: "easeInOut", delay: color === "green" ? 1.2 : 0 },
          opacity: { duration: color === "green" ? 4.5 : 5, repeat: Infinity, ease: "easeInOut", delay: color === "green" ? 2 : 0 },
          x: { duration: 0.3, repeat: Infinity, ease: "easeInOut" },
          rotate: { duration: 0.3, repeat: Infinity, ease: "easeInOut" },
          scale: { duration: 0.5, repeat: Infinity, ease: "easeInOut" },
        } : { 
          y: { duration: color === "green" ? 3.5 : 2.8, repeat: Infinity, ease: "easeInOut", delay: color === "green" ? 1.2 : 0 },
          opacity: { duration: color === "green" ? 4.5 : 5, repeat: Infinity, ease: "easeInOut", delay: color === "green" ? 2 : 0 },
        }}
      >
        <svg width="100" height="125" viewBox="0 0 80 100" className={colorClass}>
          <defs>
            <filter id={`glow-${color}`}>
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
            filter={`url(#glow-${color})`}
          />
          {expression === "happy" && (
            <>
              <motion.ellipse 
                cx="29" 
                cy="36" 
                rx="6"
                fill="#0f172a"
                animate={{ ry: [6, 6, 6, 6, 6, 6, 6, 6, 6, 1, 6] }}
                transition={{ duration: color === "green" ? 3.5 : 3, repeat: Infinity, times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1], delay: color === "green" ? 1.5 : 0 }}
              />
              <motion.ellipse 
                cx="51" 
                cy="36" 
                rx="6"
                fill="#0f172a"
                animate={{ ry: [6, 6, 6, 6, 6, 6, 6, 6, 6, 1, 6] }}
                transition={{ duration: color === "green" ? 3.5 : 3, repeat: Infinity, times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1], delay: color === "green" ? 1.5 : 0 }}
              />
              <motion.circle 
                cy="34" 
                r="2" 
                fill="white"
                animate={{ 
                  cx: [30, 30, 32, 30, 28, 30, 30],
                  opacity: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]
                }}
                transition={{ 
                  cx: { duration: color === "green" ? 4 : 3.5, repeat: Infinity, ease: "easeInOut", delay: color === "green" ? 0.5 : 0 },
                  opacity: { duration: color === "green" ? 3.5 : 3, repeat: Infinity, times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1], delay: color === "green" ? 1.5 : 0 }
                }}
              />
              <motion.circle 
                cy="34" 
                r="2" 
                fill="white"
                animate={{ 
                  cx: [52, 52, 54, 52, 50, 52, 52],
                  opacity: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]
                }}
                transition={{ 
                  cx: { duration: color === "green" ? 4 : 3.5, repeat: Infinity, ease: "easeInOut", delay: color === "green" ? 0.5 : 0 },
                  opacity: { duration: color === "green" ? 3.5 : 3, repeat: Infinity, times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1], delay: color === "green" ? 1.5 : 0 }
                }}
              />
              {isTalking ? (
                <motion.ellipse
                  cx="40"
                  cy="52"
                  rx="5"
                  fill="#0f172a"
                  animate={{ ry: [4, 7, 4, 6, 4] }}
                  transition={{ duration: 0.5, repeat: Infinity, ease: "easeInOut" }}
                />
              ) : (
                <path d="M32 50 Q40 58 48 50" stroke="#0f172a" strokeWidth="3" fill="none" strokeLinecap="round" />
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
                transition={{ duration: color === "green" ? 3.5 : 3, repeat: Infinity, times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1], delay: color === "green" ? 1.5 : 0 }}
              />
              <path d="M46 36 Q51 34 56 36" stroke="#0f172a" strokeWidth="3" fill="none" strokeLinecap="round" />
              <motion.circle 
                cy="34" 
                r="2" 
                fill="white"
                animate={{ 
                  cx: [30, 30, 32, 30, 28, 30, 30],
                  opacity: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]
                }}
                transition={{ 
                  cx: { duration: color === "green" ? 4 : 3.5, repeat: Infinity, ease: "easeInOut", delay: color === "green" ? 0.5 : 0 },
                  opacity: { duration: color === "green" ? 3.5 : 3, repeat: Infinity, times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1], delay: color === "green" ? 1.5 : 0 }
                }}
              />
              {isTalking ? (
                <motion.ellipse
                  cx="40"
                  cy="52"
                  rx="5"
                  fill="#0f172a"
                  animate={{ ry: [4, 7, 4, 6, 4] }}
                  transition={{ duration: 0.5, repeat: Infinity, ease: "easeInOut" }}
                />
              ) : (
                <path d="M32 50 Q40 58 48 50" stroke="#0f172a" strokeWidth="3" fill="none" strokeLinecap="round" />
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
                transition={{ duration: color === "green" ? 3.5 : 3, repeat: Infinity, times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1], delay: color === "green" ? 1.5 : 0 }}
              />
              <motion.ellipse 
                cx="51" 
                cy="36" 
                rx="7"
                fill="#0f172a"
                animate={{ ry: [7, 7, 7, 7, 7, 7, 7, 7, 7, 1, 7] }}
                transition={{ duration: color === "green" ? 3.5 : 3, repeat: Infinity, times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1], delay: color === "green" ? 1.5 : 0 }}
              />
              <motion.circle 
                cy="34" 
                r="2.5" 
                fill="white"
                animate={{ 
                  cx: [30, 30, 32, 30, 28, 30, 30],
                  opacity: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]
                }}
                transition={{ 
                  cx: { duration: color === "green" ? 4 : 3.5, repeat: Infinity, ease: "easeInOut", delay: color === "green" ? 0.5 : 0 },
                  opacity: { duration: color === "green" ? 3.5 : 3, repeat: Infinity, times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1], delay: color === "green" ? 1.5 : 0 }
                }}
              />
              <motion.circle 
                cy="34" 
                r="2.5" 
                fill="white"
                animate={{ 
                  cx: [52, 52, 54, 52, 50, 52, 52],
                  opacity: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]
                }}
                transition={{ 
                  cx: { duration: color === "green" ? 4 : 3.5, repeat: Infinity, ease: "easeInOut", delay: color === "green" ? 0.5 : 0 },
                  opacity: { duration: color === "green" ? 3.5 : 3, repeat: Infinity, times: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95, 1], delay: color === "green" ? 1.5 : 0 }
                }}
              />
              {isTalking ? (
                <motion.ellipse
                  cx="40"
                  cy="54"
                  rx="6"
                  fill="#0f172a"
                  animate={{ ry: [5, 9, 5, 7, 5] }}
                  transition={{ duration: 0.5, repeat: Infinity, ease: "easeInOut" }}
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
  { side: "left" as const, text: "Boo! 👻", booExpr: "happy" as const, casperExpr: "happy" as const, booScaring: true },
  { side: "right" as const, text: "Encrypted! 🔒", booExpr: "happy" as const, casperExpr: "happy" as const },
  { side: "left" as const, text: "No servers!", booExpr: "happy" as const, casperExpr: "surprised" as const },
  { side: "right" as const, text: "So private! 🎃", booExpr: "happy" as const, casperExpr: "surprised" as const },
  { side: "left" as const, text: "Messages vanish! ✨", booExpr: "wink" as const, casperExpr: "happy" as const },
  { side: "right" as const, text: "Like ghosts! 👻", booExpr: "happy" as const, casperExpr: "wink" as const },
];

function GhostConversation() {
  const [step, setStep] = useState(-1);
  
  useEffect(() => {
    const startConversation = () => {
      setStep(0);
    };
    
    const initialDelay = setTimeout(startConversation, 1500);
    
    return () => clearTimeout(initialDelay);
  }, []);

  useEffect(() => {
    if (step < 0) return;
    
    const timer = setTimeout(() => {
      setStep((prev) => (prev + 1) % conversation.length);
    }, 3500);
    
    return () => clearTimeout(timer);
  }, [step]);

  const current = step >= 0 ? conversation[step] : null;

  return (
    <div className="relative h-[200px] flex items-end justify-center">
      {/* Ghost characters container with relative positioning for bubbles */}
      <div className="flex items-end justify-center gap-12 sm:gap-24">
        {/* Boo container */}
        <div className="relative">
          {/* Boo's bubble - centered above */}
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 flex justify-center">
            <AnimatePresence mode="wait">
              {current?.side === "left" && (
                <ChatBubble key={step} side="left">
                  {current.text}
                </ChatBubble>
              )}
            </AnimatePresence>
          </div>
          <GhostCharacter 
            color="cyan" 
            delay={0.2}
            expression={current?.booExpr || "happy"}
            isTalking={current?.side === "left"}
            isScaring={current?.booScaring || false}
          />
        </div>

        {/* Casper container */}
        <div className="relative">
          {/* Casper's bubble - centered above */}
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 flex justify-center">
            <AnimatePresence mode="wait">
              {current?.side === "right" && (
                <ChatBubble key={step} side="right">
                  {current.text}
                </ChatBubble>
              )}
            </AnimatePresence>
          </div>
          <GhostCharacter 
            color="green" 
            delay={0.4}
            expression={current?.casperExpr || "happy"}
            isTalking={current?.side === "right"}
          />
        </div>
      </div>
    </div>
  );
}

function PlatformDownloadButton() {
  const [platform, setPlatform] = useState<"mac" | "linux" | "other">("other");

  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("mac")) setPlatform("mac");
    else if (ua.includes("linux")) setPlatform("linux");
    else setPlatform("other");
  }, []);

  const label =
    platform === "mac"
      ? "Download for macOS"
      : platform === "linux"
        ? "Download for Linux"
        : "Download";

  return (
    <motion.a
      href="#download"
      className="group inline-flex items-center gap-2.5 px-8 py-4 rounded-xl bg-linear-to-r from-cyan to-green text-black font-semibold text-lg transition-all hover:scale-105 hover:shadow-lg hover:shadow-cyan/20"
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.97 }}
    >
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
      </svg>
      {label}
    </motion.a>
  );
}

export function Hero() {
  const [tagline, setTagline] = useState(taglines[0]);

  useEffect(() => {
    setTagline(taglines[Math.floor(Math.random() * taglines.length)]);
  }, []);

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center px-6 pt-20 pb-32 overflow-hidden">
      <div className="absolute inset-0 bg-grid" />
      
      {/* Floating ghost particles */}
      <GhostParticles />

      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-cyan/5 rounded-full blur-3xl" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-green/5 rounded-full blur-3xl" />

      <div className="relative z-10 flex flex-col items-center text-center max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-cyan/20 bg-cyan/5 text-cyan text-sm font-mono mb-8"
        >
          <motion.span
            animate={{ y: [0, -2, 0], opacity: [1, 0.7, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          >
            <GhostIcon className="w-4 h-4" />
          </motion.span>
          {tagline}
        </motion.div>

        <h1 className="font-mono font-bold tracking-tight mb-4">
          <span className="flex flex-wrap justify-center gap-x-3 items-end">
            {title.split("").map((char, i) => (
              <motion.span
                key={i}
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 + i * 0.06, duration: 0.5 }}
                className="text-6xl sm:text-7xl md:text-8xl lg:text-9xl text-gradient-animated inline-block leading-none"
                style={{ paddingBottom: "0.15em" }}
              >
                {char === " " ? "\u00A0" : char}
              </motion.span>
            ))}
          </span>
        </h1>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8, duration: 0.6 }}
          className="w-full mb-10"
        >
          <GhostConversation />
        </motion.div>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.0, duration: 0.6 }}
          className="text-xl sm:text-2xl md:text-3xl text-gray-400 font-light max-w-2xl mb-4"
        >
          Your messages. <span className="text-cyan">Invisible</span> to everyone else.
        </motion.p>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.2, duration: 0.6 }}
          className="text-lg text-gray-500 max-w-xl mb-10"
        >
          Your chats float through 10M+ nodes and vanish without a trace.
          No servers. No accounts. Just pure, spooky privacy.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.4, duration: 0.6 }}
          className="flex flex-col sm:flex-row gap-4"
        >
          <PlatformDownloadButton />
          <motion.a
            href="https://github.com/MiguelMedeiros/ghostly"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2.5 px-8 py-4 rounded-xl border border-border text-gray-300 font-semibold text-lg hover:border-cyan/40 hover:text-cyan transition-all"
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            View on GitHub
          </motion.a>
        </motion.div>
      </div>
    </section>
  );
}

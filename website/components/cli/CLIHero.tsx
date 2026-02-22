"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";

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
      className="absolute pointer-events-none text-green"
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
      Array.from({ length: 20 }, (_, i) => ({
        id: i,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: 16 + Math.random() * 40,
        delay: Math.random() * 8,
        duration: 8 + Math.random() * 10,
        opacity: 0.04 + Math.random() * 0.08,
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

function TerminalIcon({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 9l4 3-4 3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 15h6" strokeLinecap="round" />
    </svg>
  );
}

export function CLIHero() {
  return (
    <section className="relative min-h-[70vh] flex flex-col items-center justify-center px-6 pt-28 pb-20 overflow-hidden">
      <div className="absolute inset-0 bg-grid" />
      <GhostParticles />
      
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-cyan/5 rounded-full blur-3xl" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-green/5 rounded-full blur-3xl" />

      <div className="relative z-10 flex flex-col items-center text-center max-w-4xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-green/20 bg-green/5 text-green text-sm font-mono mb-8"
        >
          <TerminalIcon className="w-4 h-4" />
          For Bots & Automation
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.6 }}
          className="font-mono font-bold text-5xl sm:text-6xl md:text-7xl mb-6"
        >
          <span className="text-gradient-animated">ghostly-cli</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.6 }}
          className="text-xl sm:text-2xl text-gray-400 font-light max-w-2xl mb-4"
        >
          Ghost Protocol for <span className="text-green">bots</span> and <span className="text-cyan">automation</span>
        </motion.p>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6, duration: 0.6 }}
          className="text-lg text-gray-500 max-w-xl mb-10"
        >
          Send and receive encrypted ephemeral messages from your scripts, 
          bots, and AI agents. No servers, no accounts, just pure P2P.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8, duration: 0.6 }}
          className="flex flex-col sm:flex-row gap-4"
        >
          <a
            href="#install"
            className="inline-flex items-center gap-2.5 px-8 py-4 rounded-xl bg-linear-to-r from-cyan to-green text-black font-semibold text-lg transition-all hover:scale-105 hover:shadow-lg hover:shadow-cyan/20"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Install Now
          </a>
          <a
            href="#examples"
            className="inline-flex items-center gap-2.5 px-8 py-4 rounded-xl border border-border text-gray-300 font-semibold text-lg hover:border-cyan/40 hover:text-cyan transition-all"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
            See Examples
          </a>
        </motion.div>
      </div>
    </section>
  );
}

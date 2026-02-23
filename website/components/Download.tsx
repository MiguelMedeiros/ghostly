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
      className="absolute pointer-events-none text-cyan"
      style={{ 
        left: `${x}%`, 
        top: `${y}%`,
        width: size,
        height: size,
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
      Array.from({ length: 15 }, (_, i) => ({
        id: i,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: 24 + Math.random() * 40,
        delay: Math.random() * 8,
        duration: 8 + Math.random() * 8,
        opacity: 0.08 + Math.random() * 0.12,
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

export function Download() {
  return (
    <section id="download" className="relative py-32 px-6 overflow-hidden">
      <div className="absolute inset-0 bg-linear-to-b from-transparent via-cyan/[0.03] to-transparent" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-cyan/5 rounded-full blur-3xl" />
      
      {/* Floating ghost particles */}
      <GhostParticles />

      <div className="relative max-w-3xl mx-auto text-center">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="flex flex-col items-center"
        >
          <motion.div
            animate={{ y: [0, -8, 0] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
            className="mb-6"
          >
            <svg className="w-16 h-16 text-cyan" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/>
              <circle cx="9" cy="9" r="1.5" className="fill-background"/>
              <circle cx="15" cy="9" r="1.5" className="fill-background"/>
            </svg>
          </motion.div>
          <span className="font-mono text-sm text-cyan mb-4 tracking-wider uppercase">
            Join the Haunting
          </span>
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-mono font-bold mb-6">
            Become a <span className="text-gradient-animated">Ghost</span>
          </h2>
          <p className="text-lg text-gray-400 max-w-lg mx-auto mb-12">
            Download and start haunting in seconds.
            No sign-up. No traces. Just you and your ghostly friends.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.2, duration: 0.5 }}
          className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8 max-w-2xl mx-auto"
        >
          {/* macOS */}
          <div className="group relative rounded-xl border border-border/50 bg-surface/50 p-5 hover:border-cyan/40 transition-all">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center">
                <svg className="w-5 h-5 text-gray-300" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
                </svg>
              </div>
              <span className="font-semibold text-gray-100">macOS</span>
            </div>
            <div className="flex flex-col gap-2">
              <a
                href="https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.3/Ghostly_0.1.2_aarch64.dmg"
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-cyan/10 text-cyan text-sm font-medium hover:bg-cyan/20 transition-colors"
              >
                <span>Apple Silicon</span>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </a>
              <a
                href="https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.3/Ghostly_0.1.2_x64.dmg"
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-800/50 text-gray-400 text-sm hover:bg-gray-800 hover:text-gray-200 transition-colors"
              >
                <span>Intel</span>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </a>
            </div>
          </div>

          {/* Windows */}
          <div className="group relative rounded-xl border border-border/50 bg-surface/50 p-5 hover:border-cyan/40 transition-all">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center">
                <svg className="w-5 h-5 text-gray-300" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
                </svg>
              </div>
              <span className="font-semibold text-gray-100">Windows</span>
            </div>
            <div className="flex flex-col gap-2">
              <a
                href="https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.3/Ghostly_0.1.2_x64-setup.exe"
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-cyan/10 text-cyan text-sm font-medium hover:bg-cyan/20 transition-colors"
              >
                <span>Installer (.exe)</span>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </a>
              <a
                href="https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.3/Ghostly_0.1.2_x64_en-US.msi"
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-800/50 text-gray-400 text-sm hover:bg-gray-800 hover:text-gray-200 transition-colors"
              >
                <span>MSI Package</span>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </a>
            </div>
          </div>

          {/* Linux */}
          <div className="group relative rounded-xl border border-border/50 bg-surface/50 p-5 hover:border-cyan/40 transition-all">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center">
                <svg className="w-5 h-5 text-gray-300" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M20.581 19.049c-.55-.446-.336-1.431-.907-1.917.553-3.365-.997-6.331-2.845-8.232-1.551-1.595-1.051-3.147-1.051-4.49 0-2.146-.881-4.41-3.55-4.41C9.56 0 8.677 2.264 8.677 4.41c0 1.343.5 2.895-1.051 4.49-1.848 1.901-3.398 4.867-2.845 8.232-.571.486-.357 1.471-.907 1.917-.55.446-.027.934.638.934H6.54c.459 0 .88-.282 1.076-.721.166-.373.5-.665.89-.665h7.022c.39 0 .724.292.89.665.195.439.617.721 1.076.721h2.028c.665 0 1.188-.488.638-.934zM12.228 3.677a1.2 1.2 0 110 2.4 1.2 1.2 0 010-2.4z" />
                </svg>
              </div>
              <span className="font-semibold text-gray-100">Linux</span>
            </div>
            <div className="flex flex-col gap-2">
              <a
                href="https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.3/Ghostly_0.1.2_amd64.deb"
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-cyan/10 text-cyan text-sm font-medium hover:bg-cyan/20 transition-colors"
              >
                <span>.deb</span>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </a>
              <a
                href="https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.3/Ghostly_0.1.2_amd64.AppImage"
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-800/50 text-gray-400 text-sm hover:bg-gray-800 hover:text-gray-200 transition-colors"
              >
                <span>.AppImage</span>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </a>
            </div>
          </div>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.3 }}
          className="text-sm text-gray-500 mb-8"
        >
          v0.1.3 •{" "}
          <a
            href="https://github.com/MiguelMedeiros/ghostly/releases/tag/v0.1.3"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-cyan transition-colors underline underline-offset-2"
          >
            View all releases
          </a>
        </motion.p>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.4, duration: 0.5 }}
          className="flex flex-col sm:flex-row items-center justify-center gap-6 text-sm"
        >
          <a
            href="https://github.com/MiguelMedeiros/ghostly"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-gray-500 hover:text-cyan transition-colors"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            Build from source
          </a>

          <span className="text-gray-700 hidden sm:inline">|</span>

          <a
            href="https://github.com/MiguelMedeiros/ghostly"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-gray-500 hover:text-yellow-400 transition-colors"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
            Star on GitHub
          </a>
        </motion.div>
      </div>
    </section>
  );
}

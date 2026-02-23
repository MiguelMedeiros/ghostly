"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";

export function DocsNavbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <motion.nav
      initial={{ y: -80 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.5 }}
      className={`fixed top-0 left-0 right-0 z-50 transition-[background-color,border-color,backdrop-filter] duration-300 ${
        scrolled
          ? "bg-[#060a10]/80 backdrop-blur-xl border-b border-border/30"
          : "bg-transparent border-b border-transparent"
      }`}
    >
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <a
            href="/"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-gray-400 hover:text-cyan hover:bg-cyan/10 transition-all"
            title="Back to Home"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </a>
          <a href="/docs" className="flex items-center gap-2.5 group">
            <motion.div
              animate={{ y: [0, -2, 0] }}
              transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
              className="relative"
            >
              <svg className="w-6 h-6 text-cyan transition-all group-hover:text-green group-hover:scale-110 duration-300" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/>
                <circle cx="9" cy="9" r="1.5" className="fill-background"/>
                <circle cx="15" cy="9" r="1.5" className="fill-background"/>
              </svg>
            </motion.div>
            <span className="font-mono font-bold text-sm">
              <span className="text-gradient">Ghostly</span>
              <span className="text-cyan ml-1">Docs</span>
            </span>
          </a>
        </div>

        <div className="hidden lg:flex items-center gap-6 text-sm text-gray-400 absolute left-1/2 -translate-x-1/2">
          <a href="#overview" className="hover:text-cyan transition-colors">
            Overview
          </a>
          <a href="#architecture" className="hover:text-cyan transition-colors">
            Architecture
          </a>
          <a href="#dns-records" className="hover:text-cyan transition-colors">
            DNS Records
          </a>
          <a href="#encryption" className="hover:text-cyan transition-colors">
            Encryption
          </a>
          <a href="#call-signaling" className="hover:text-cyan transition-colors">
            Calls
          </a>
        </div>

        <div className="flex items-center gap-3">
          <a
            href="https://github.com/MiguelMedeiros/ghostly"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-500 hover:text-cyan transition-colors"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
          </a>
          <a
            href="/#download"
            className="px-4 py-1.5 rounded-lg bg-cyan/10 text-cyan text-sm font-medium border border-cyan/20 hover:bg-cyan/20 transition-colors"
          >
            Download
          </a>
        </div>
      </div>
    </motion.nav>
  );
}

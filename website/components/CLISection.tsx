"use client";

import { motion } from "motion/react";

export function CLISection() {
  return (
    <section id="cli" className="relative py-24 px-6">
      <div className="max-w-4xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12"
        >
          <span className="font-mono text-sm text-green mb-4 tracking-wider uppercase inline-block">
            For Developers
          </span>
          <h2 className="text-3xl sm:text-4xl font-mono font-bold mb-4">
            <span className="text-gradient">Ghostly</span> CLI
          </h2>
          <p className="text-gray-400 max-w-xl mx-auto">
            Ghost protocol for bots, scripts, and automation.
            Send and receive encrypted ephemeral messages from the terminal.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.2, duration: 0.5 }}
          className="rounded-xl border border-border/50 bg-surface/50 overflow-hidden"
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30 bg-gray-900/50">
            <div className="flex gap-1.5">
              <div className="w-3 h-3 rounded-full bg-red-500/80" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
              <div className="w-3 h-3 rounded-full bg-green/80" />
            </div>
            <span className="text-xs text-gray-500 ml-2 font-mono">terminal</span>
          </div>
          
          <div className="p-6 font-mono text-sm space-y-4">
            <div>
              <span className="text-gray-500"># Install via cargo</span>
              <div className="flex items-start gap-2 mt-1">
                <span className="text-green">$</span>
                <span className="text-gray-300">cargo install ghostly-cli</span>
              </div>
            </div>
            
            <div>
              <span className="text-gray-500"># Create a new identity</span>
              <div className="flex items-start gap-2 mt-1">
                <span className="text-green">$</span>
                <span className="text-gray-300">ghostly-cli identity new</span>
              </div>
              <div className="text-cyan/80 mt-1 ml-4">
                → {`{"seed":"...","pubkey":"...","shared_key":"..."}`}
              </div>
            </div>
            
            <div>
              <span className="text-gray-500"># Generate an invite link</span>
              <div className="flex items-start gap-2 mt-1">
                <span className="text-green">$</span>
                <span className="text-gray-300">ghostly-cli invite new --seed $SEED</span>
              </div>
              <div className="text-cyan/80 mt-1 ml-4">
                → {`{"invite_url":"ghost://abc123...#key"}`}
              </div>
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.4 }}
          className="flex flex-col sm:flex-row items-center justify-center gap-4 mt-8"
        >
          <a
            href="/cli"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-green/10 text-green font-medium border border-green/20 hover:bg-green/20 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
            </svg>
            View CLI Documentation
          </a>
          <a
            href="https://github.com/MiguelMedeiros/ghostly/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-gray-400 hover:text-gray-200 transition-colors text-sm"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            GitHub releases
          </a>
        </motion.div>
      </div>
    </section>
  );
}

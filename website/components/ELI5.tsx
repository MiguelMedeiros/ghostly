"use client";

import { motion } from "motion/react";
import Image from "next/image";

export function ELI5() {
  return (
    <section id="eli5" className="relative py-24 px-6 bg-surface/50">
      <div className="max-w-4xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-8"
        >
          <span className="inline-block font-mono text-sm text-cyan mb-4 tracking-wider uppercase">
            The Ghost Story
          </span>
          <h2 className="text-3xl sm:text-4xl font-mono font-bold mb-4">
            How <span className="text-gradient">Ghostly</span> works
          </h2>
          <p className="text-gray-500">
            A tale of privacy in 6 panels
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={{ once: true, margin: "-50px" }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="relative"
        >
          {/* Comic strip container with comic-style border */}
          <div className="relative rounded-2xl overflow-hidden border-4 border-cyan/30 shadow-2xl shadow-cyan/10 bg-[#0a1628]">
            {/* Comic book style halftone dots overlay */}
            <div 
              className="absolute inset-0 opacity-[0.03] pointer-events-none"
              style={{
                backgroundImage: `radial-gradient(circle, #00d4aa 1px, transparent 1px)`,
                backgroundSize: '8px 8px'
              }}
            />
            
            <Image
              src="/ghost-comic-strip.png"
              alt="How Ghostly works - A 12-panel comic showing ghost characters Boo and Casper explaining encrypted messaging through the DHT network, covering secret mailboxes, encryption, decentralized nodes, and ephemeral messages"
              width={1024}
              height={576}
              className="w-full h-auto relative z-10"
              priority
            />
            
            {/* Corner decorations for comic feel */}
            <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-cyan/50 rounded-tl-xl" />
            <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-cyan/50 rounded-tr-xl" />
            <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-cyan/50 rounded-bl-xl" />
            <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-cyan/50 rounded-br-xl" />
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.5 }}
          className="mt-8 text-center"
        >
          <div className="inline-flex items-center gap-3 bg-cyan/10 border border-cyan/20 rounded-full px-6 py-3">
            <svg className="w-5 h-5 text-cyan" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/>
              <circle cx="9" cy="9" r="1.5" className="fill-background"/>
              <circle cx="15" cy="9" r="1.5" className="fill-background"/>
            </svg>
            <span className="text-sm text-gray-300">
              The end. Now go haunt someone!
            </span>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

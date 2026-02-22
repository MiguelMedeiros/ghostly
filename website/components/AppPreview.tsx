"use client";

import { motion } from "motion/react";
import { MockupApp } from "./MockupApp";

export function AppPreview() {
  return (
    <section id="preview" className="relative py-24 px-6">
      <div className="absolute inset-0 bg-grid opacity-50" />
      <div className="absolute top-1/3 left-1/4 w-80 h-80 bg-cyan/5 rounded-full blur-3xl" />
      <div className="absolute bottom-1/3 right-1/4 w-80 h-80 bg-green/5 rounded-full blur-3xl" />

      <div className="relative z-10 max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12"
        >
          <span className="inline-block font-mono text-sm text-cyan mb-4 tracking-wider uppercase">
            See it in action
          </span>
          <h2 className="text-3xl sm:text-4xl font-mono font-bold mb-4">
            A glimpse of <span className="text-gradient">Ghostly</span>
          </h2>
          <p className="text-gray-500 max-w-xl mx-auto">
            Clean, intuitive interface. Everything you need, nothing you don&apos;t.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 40, scale: 0.95 }}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={{ once: true, margin: "-50px" }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="max-w-4xl mx-auto"
        >
          <MockupApp />
        </motion.div>
      </div>
    </section>
  );
}

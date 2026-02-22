"use client";

import { motion } from "motion/react";

export function Download() {
  return (
    <section id="download" className="relative py-32 px-6">
      <div className="absolute inset-0 bg-linear-to-b from-transparent via-cyan/[0.03] to-transparent" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-cyan/5 rounded-full blur-3xl" />

      <div className="relative max-w-3xl mx-auto text-center">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
        >
          <span className="inline-block font-mono text-sm text-cyan mb-4 tracking-wider uppercase">
            Get Started
          </span>
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-mono font-bold mb-6">
            Get <span className="text-gradient-animated">Dead Drop</span>
          </h2>
          <p className="text-lg text-gray-400 max-w-lg mx-auto mb-12">
            Download the app and start chatting in seconds.
            No sign-up, no configuration, no compromise.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.2, duration: 0.5 }}
          className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-12"
        >
          <motion.a
            href="#"
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            className="group flex items-center gap-3 px-8 py-4 rounded-xl bg-linear-to-r from-cyan to-green text-black font-semibold text-lg w-full sm:w-auto justify-center"
          >
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
            </svg>
            Download for macOS
          </motion.a>

          <motion.a
            href="#"
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            className="group flex items-center gap-3 px-8 py-4 rounded-xl border border-border text-gray-200 font-semibold text-lg hover:border-cyan/40 hover:text-cyan transition-all w-full sm:w-auto justify-center"
          >
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M20.581 19.049c-.55-.446-.336-1.431-.907-1.917.553-3.365-.997-6.331-2.845-8.232-1.551-1.595-1.051-3.147-1.051-4.49 0-2.146-.881-4.41-3.55-4.41C9.56 0 8.677 2.264 8.677 4.41c0 1.343.5 2.895-1.051 4.49-1.848 1.901-3.398 4.867-2.845 8.232-.571.486-.357 1.471-.907 1.917-.55.446-.027.934.638.934H6.54c.459 0 .88-.282 1.076-.721.166-.373.5-.665.89-.665h7.022c.39 0 .724.292.89.665.195.439.617.721 1.076.721h2.028c.665 0 1.188-.488.638-.934zM12.228 3.677a1.2 1.2 0 110 2.4 1.2 1.2 0 010-2.4z" />
            </svg>
            Download for Linux
          </motion.a>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.4, duration: 0.5 }}
          className="flex flex-col sm:flex-row items-center justify-center gap-6 text-sm"
        >
          <a
            href="https://github.com/miguelmedeiros/pkarr-chat"
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
            href="https://github.com/miguelmedeiros/pkarr-chat"
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

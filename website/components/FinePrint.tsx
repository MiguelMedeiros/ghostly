"use client";

import { motion } from "motion/react";

const items = [
  {
    title: "Who sees what",
    body: "Relays, STUN and TURN only see signed, encrypted packets. They never carry your messages, files or apps.",
  },
  {
    title: "Your sats are pocket money",
    body: "Ecash is custodial: the mint holds the sats and could lose them. No seed backup yet.",
  },
  {
    title: "Sharing localhost is sharing",
    body: "A contact can use a shared app exactly as you can. Share only what you would let them use.",
  },
  {
    title: "The web app trusts its server",
    body: "Whoever serves a web page can change it. Host it yourself, or install the extension or desktop app.",
  },
  {
    title: "Still rough",
    body: "No WebSockets through shared apps yet. Both peers must be online for files, sats and apps. It is a 0.2.",
  },
  {
    title: "Verify, don't trust",
    body: "Open source, documented protocol, signed checksums.",
  },
];

export function FinePrint() {
  return (
    <section id="fine-print" className="relative py-24 px-6">
      <div className="max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12"
        >
          <h2 className="text-4xl sm:text-5xl font-mono font-bold mb-6">
            The fine print, <span className="text-gradient">no tricks</span>
          </h2>
          <p className="text-lg text-gray-400 max-w-2xl mx-auto">
            What Ghostly does not do, and what you are trusting.
          </p>
        </motion.div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((item, index) => (
            <motion.div
              key={item.title}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.4, delay: index * 0.05 }}
              className="rounded-xl border border-border/50 bg-surface p-5"
            >
              <h3 className="font-mono font-bold text-gray-100 mb-2">{item.title}</h3>
              <p className="text-sm text-gray-500 leading-relaxed">{item.body}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

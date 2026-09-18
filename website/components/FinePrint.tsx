"use client";

import { motion } from "motion/react";

const items = [
  {
    title: "Who sees what",
    body: "Pkarr relays, STUN and TURN only ever see signed, encrypted packets. They help ghosts find and reach each other. They hold no state about you and never carry your messages, files or apps.",
  },
  {
    title: "Your sats are pocket money",
    body: "The wallet holds ecash. A mint keeps the sats and could lose them or vanish. There is no seed backup yet. Treat it like the coins in your coat, not like your savings.",
  },
  {
    title: "Sharing localhost is sharing",
    body: "A contact can use the app you share exactly as you can on localhost. Only what you list is reachable, only by the people you linked with, only while you are online. Share apps you would let them use.",
  },
  {
    title: "The web app trusts its server",
    body: "A page is code a server hands you on every visit. Whoever runs that server could change it. Host it yourself, or use the extension or the desktop app, which you install once.",
  },
  {
    title: "Still rough",
    body: "No WebSockets or streaming through shared apps yet. Linux desktops often lack WebRTC in their WebView. Both peers must be online for files, sats and apps. It is a 0.2.",
  },
  {
    title: "Verify, don't trust",
    body: "Everything is open source, the protocol is documented, and releases ship with signed checksums. If a ghost tells you to trust it, check its sheet.",
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
            Ghosts are honest about what they are. Here is what Ghostly does not do, and what you are trusting when you use it.
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

"use client";

import { motion, AnimatePresence } from "motion/react";
import { useEffect, useState } from "react";

/** The one thing no other messenger does, acted out: a localhost app, shared and opened. */
const STEPS = [
  { host: "typing", caption: "You have something running on your machine." },
  { host: "shared", caption: "Share it. Ghostly advertises it to your contacts, signed and encrypted." },
  { host: "shared", guest: "sees", caption: "Your contact sees it appear. Not the address, just the name." },
  { host: "shared", guest: "open", caption: "They open it. Every request rides WebRTC, straight to your localhost." },
  { host: "gone", guest: "gone", caption: "Close Ghostly and it is gone. That is the point." },
] as const;

function Window({ title, children, tone }: { title: string; children: React.ReactNode; tone: "cyan" | "green" }) {
  return (
    <div className={`rounded-xl border bg-surface overflow-hidden ${tone === "cyan" ? "border-cyan/30" : "border-green/30"}`}>
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border/50 bg-black/30">
        <span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
        <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/70" />
        <span className="w-2.5 h-2.5 rounded-full bg-green-500/70" />
        <span className="ml-2 text-xs font-mono text-gray-500">{title}</span>
      </div>
      <div className="p-4 min-h-[190px] font-mono text-sm">{children}</div>
    </div>
  );
}

export function ShareDemo() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setIndex((i) => (i + 1) % STEPS.length), 3200);
    return () => clearInterval(timer);
  }, []);
  const step = STEPS[index];
  const guest = "guest" in step ? step.guest : undefined;

  return (
    <section id="share" className="relative py-24 px-6">
      <div className="max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12"
        >
          <h2 className="text-4xl sm:text-5xl font-mono font-bold mb-6">
            Haunt your own <span className="text-gradient">localhost</span>
          </h2>
          <p className="text-lg text-gray-400 max-w-2xl mx-auto">
            You are the server while you are online. No deploy, no tunnel company, no account.
            Your contact&apos;s browser talks to your machine through a peer to peer connection, and only to the app you picked.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-[1fr_auto_1fr] gap-4 items-center">
          <Window title="you · Ghostly" tone="cyan">
            <p className="text-gray-500 text-xs mb-3">SERVICES</p>
            {step.host === "typing" && (
              <div className="space-y-2">
                <div className="rounded-lg bg-black/40 px-3 py-2 text-gray-300">Atlas</div>
                <div className="rounded-lg bg-black/40 px-3 py-2 text-cyan">
                  localhost:3400
                  <motion.span animate={{ opacity: [1, 0, 1] }} transition={{ duration: 1, repeat: Infinity }}>▍</motion.span>
                </div>
                <div className="rounded-lg bg-cyan text-black text-center font-semibold py-2">Share</div>
              </div>
            )}
            {step.host === "shared" && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-lg bg-black/40 px-3 py-3">
                <div className="flex justify-between text-gray-200"><span>Atlas</span><span className="text-xs text-gray-500">Stop</span></div>
                <div className="text-xs text-gray-500">localhost:3400</div>
                <div className="text-xs text-cyan mt-2 flex items-center gap-1.5">
                  <motion.span className="w-1.5 h-1.5 rounded-full bg-cyan" animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.6, repeat: Infinity }} />
                  Shared with your contacts
                  {guest === "open" && <span className="ml-auto text-gray-500">12 requests</span>}
                </div>
              </motion.div>
            )}
            {step.host === "gone" && (
              <motion.div initial={{ opacity: 1 }} animate={{ opacity: 0.25 }} transition={{ duration: 1.2 }} className="text-center text-gray-500 pt-10">
                <div className="text-4xl mb-2">👻</div>
                offline
              </motion.div>
            )}
          </Window>

          <div className="flex md:flex-col items-center justify-center gap-2 text-xs font-mono text-gray-500 py-2">
            <span>Pkarr finds</span>
            <motion.div
              className="h-px w-16 md:w-px md:h-16 bg-linear-to-r md:bg-linear-to-b from-cyan to-green"
              animate={{ opacity: guest === "open" ? [0.3, 1, 0.3] : 0.3 }}
              transition={{ duration: 0.8, repeat: Infinity }}
            />
            <span className={guest === "open" ? "text-green" : ""}>WebRTC carries</span>
          </div>

          <Window title={guest === "open" ? "atlas.k7x…9d.ghostly" : "your contact · Ghostly"} tone="green">
            {!guest && <p className="text-gray-600 pt-12 text-center">…</p>}
            {guest === "sees" && (
              <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}>
                <p className="text-gray-500 text-xs mb-3">● Peer to peer</p>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-green text-black font-semibold text-xs px-3 py-1.5">🌐 Atlas</span>
              </motion.div>
            )}
            {guest === "open" && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2">
                <div className="h-3 w-24 rounded bg-green/40" />
                <div className="grid grid-cols-3 gap-2">
                  {[0, 1, 2].map((i) => (
                    <motion.div key={i} className="h-14 rounded bg-white/5" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 * i }} />
                  ))}
                </div>
                <div className="h-2 w-full rounded bg-white/5" />
                <div className="h-2 w-2/3 rounded bg-white/5" />
                <p className="text-[10px] text-gray-600 pt-1">served from your contact&apos;s machine</p>
              </motion.div>
            )}
            {guest === "gone" && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center text-gray-500 pt-8">
                <div className="text-4xl mb-2">👻</div>
                <p className="text-xs">This service is not reachable.<br />Services exist while their ghost is online.</p>
              </motion.div>
            )}
          </Window>
        </div>

        <AnimatePresence mode="wait">
          <motion.p
            key={index}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="text-center text-gray-400 mt-8 min-h-[3rem]"
          >
            <span className="font-mono text-cyan mr-2">{String(index + 1).padStart(2, "0")}</span>
            {step.caption}
          </motion.p>
        </AnimatePresence>

        <div className="flex flex-wrap justify-center gap-3 text-xs text-gray-600">
          <span className="px-3 py-1 rounded-full border border-border/30">Only what you list is reachable</span>
          <span className="px-3 py-1 rounded-full border border-border/30">Contacts ask for a name, never a URL</span>
          <span className="px-3 py-1 rounded-full border border-border/30">Loopback only, no redirects out</span>
          <span className="px-3 py-1 rounded-full border border-border/30">Its own origin, never Ghostly&apos;s</span>
        </div>
      </div>
    </section>
  );
}

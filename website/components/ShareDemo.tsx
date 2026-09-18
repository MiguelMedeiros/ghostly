"use client";

import { motion, AnimatePresence } from "motion/react";
import { useEffect, useState } from "react";
import { GhostGlyph } from "./icons";

/**
 * The idea in one picture: something runs on your computer, you flip a switch,
 * and the very same page shows up in a friend's browser. Close Ghostly and it
 * is gone. The mini site is drawn identically on both sides on purpose.
 */
const STEPS = [
  { title: "It runs on your computer", text: "A site you are building, a dashboard, a photo gallery. Only you can see it, at localhost." },
  { title: "You flip one switch", text: "Ghostly tells the friends you chose that it exists. They see its name, never your address." },
  { title: "They open it in their browser", text: "The same page, live from your machine, through an encrypted peer to peer connection. Nothing is uploaded anywhere." },
  { title: "Close Ghostly and the door is gone", text: "No server kept a copy, because there was no server. It only existed while you were online." },
] as const;

const TILES = ["from-cyan/70 to-cyan/20", "from-green/70 to-green/20", "from-purple-400/70 to-purple-400/20", "from-yellow-400/70 to-yellow-400/20", "from-pink-400/70 to-pink-400/20", "from-sky-400/70 to-sky-400/20"];

/** The little site being shared. Same drawing on both sides: it IS the same page. */
function MiniSite() {
  return (
    <div className="rounded-md bg-[#0d1420] border border-white/5 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold text-gray-200">My photos</span>
        <span className="text-[9px] text-gray-500">summer ’26</span>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {TILES.map((tile) => (
          <div key={tile} className={`h-9 rounded bg-linear-to-br ${tile}`} />
        ))}
      </div>
    </div>
  );
}

function BrowserFrame({ address, tone, children, dim }: { address: React.ReactNode; tone: "cyan" | "green"; children: React.ReactNode; dim?: boolean }) {
  return (
    <motion.div
      animate={{ opacity: dim ? 0.35 : 1 }}
      transition={{ duration: 0.6 }}
      className={`rounded-xl border bg-surface overflow-hidden ${tone === "cyan" ? "border-cyan/30" : "border-green/30"}`}
    >
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border/50 bg-black/30">
        <span className="w-2 h-2 rounded-full bg-red-500/70" />
        <span className="w-2 h-2 rounded-full bg-yellow-500/70" />
        <span className="w-2 h-2 rounded-full bg-green-500/70" />
        <span className="ml-2 flex-1 rounded bg-black/40 px-2 py-0.5 text-[10px] font-mono text-gray-400 truncate">{address}</span>
      </div>
      <div className="p-3">{children}</div>
    </motion.div>
  );
}

/** Packets running along the door between the two machines. */
function Beam({ active }: { active: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 md:w-32 md:pt-24">
      <div className="relative w-full h-4 flex items-center">
        <div className={`h-0.5 w-full rounded-full transition-colors duration-500 ${active ? "bg-linear-to-r from-cyan to-green" : "bg-border/40"}`} />
        {active &&
          [0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="absolute top-1/2 -mt-1 -ml-1 w-2 h-2 rounded-full bg-white shadow-[0_0_10px_2px] shadow-cyan"
              initial={{ left: "0%", opacity: 0 }}
              animate={{ left: ["0%", "100%"], opacity: [0, 1, 1, 0] }}
              transition={{ duration: 1.4, delay: i * 0.45, repeat: Infinity, ease: "linear" }}
            />
          ))}
      </div>
      <span className={`text-[10px] font-mono uppercase tracking-wider text-center transition-colors duration-500 ${active ? "text-green" : "text-gray-600"}`}>
        {active ? "encrypted, peer to peer" : "door closed"}
      </span>
    </div>
  );
}

export function ShareDemo() {
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => setStep((s) => (s + 1) % STEPS.length), 3800);
    return () => clearInterval(timer);
  }, [paused]);

  const sharing = step === 1 || step === 2;
  const opened = step === 2;
  const closed = step === 3;

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
            Open a door to your <span className="text-gradient">localhost</span>
          </h2>
          <p className="text-lg text-gray-400 max-w-2xl mx-auto">
            Got something running on your computer? Flip one switch and the friends you chose can open it in their
            browser, straight from your machine. It stays open <span className="text-cyan">only while Ghostly is open</span>.
          </p>
        </motion.div>

        <div
          className="grid md:grid-cols-[1fr_auto_1fr] gap-4 md:gap-3 items-start"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          {/* Your computer */}
          <div>
            <p className="text-xs font-mono uppercase tracking-wider text-cyan mb-2">Your computer</p>
            <BrowserFrame tone="cyan" address="localhost:3000" dim={closed}>
              <MiniSite />
            </BrowserFrame>

            <motion.div
              animate={{ opacity: closed ? 0.35 : 1 }}
              className="mt-3 rounded-xl border border-border/50 bg-surface px-4 py-3 flex items-center gap-3"
            >
              <GhostGlyph className="w-5 h-5 text-cyan shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-gray-200 leading-tight">{closed ? "Ghostly is closed" : "Share “My photos”"}</p>
                <p className="text-[11px] text-gray-500">
                  {closed ? "you went offline" : sharing ? "shared with your friends" : "only you can see it"}
                </p>
              </div>
              <div className={`relative w-11 h-6 rounded-full transition-colors duration-300 ${sharing ? "bg-cyan" : "bg-border"}`}>
                <motion.span
                  className="absolute top-1 w-4 h-4 rounded-full bg-white"
                  animate={{ left: sharing ? 24 : 4 }}
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                />
              </div>
            </motion.div>
          </div>

          <Beam active={sharing} />

          {/* Your friend's browser */}
          <div>
            <p className="text-xs font-mono uppercase tracking-wider text-green mb-2">Your friend&apos;s browser</p>
            <BrowserFrame
              tone="green"
              address={opened ? <span className="text-green">my-photos · live from your computer</span> : "Ghostly"}
            >
              <div className="min-h-[124px] flex flex-col justify-center">
                <AnimatePresence mode="wait">
                  {step === 0 && (
                    <motion.p key="nothing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-center text-sm text-gray-600">
                      Nothing to see yet.
                    </motion.p>
                  )}
                  {step === 1 && (
                    <motion.div key="offer" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="text-center">
                      <p className="text-xs text-gray-500 mb-2">Your friend shares something:</p>
                      <motion.span
                        animate={{ scale: [1, 1.06, 1] }}
                        transition={{ duration: 1.2, repeat: Infinity }}
                        className="inline-flex items-center rounded-full bg-green text-black font-semibold text-sm px-4 py-1.5"
                      >
                        Open “My photos”
                      </motion.span>
                    </motion.div>
                  )}
                  {step === 2 && (
                    <motion.div key="site" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                      <MiniSite />
                    </motion.div>
                  )}
                  {step === 3 && (
                    <motion.div key="gone" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-center text-gray-500">
                      <GhostGlyph className="w-9 h-9 mx-auto mb-2 text-gray-600" />
                      <p className="text-sm">Poof. It is gone.</p>
                      <p className="text-[11px] text-gray-600">It only existed while your friend was online.</p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </BrowserFrame>
          </div>
        </div>

        {/* The same story in words; click a step to jump to it. */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-10">
          {STEPS.map((item, index) => (
            <button
              key={item.title}
              onClick={() => setStep(index)}
              className={`text-left rounded-xl border p-4 transition-all cursor-pointer ${
                index === step ? "border-cyan/50 bg-cyan/5" : "border-border/40 bg-surface/50 hover:border-border"
              }`}
            >
              <span className={`font-mono text-xs ${index === step ? "text-cyan" : "text-gray-600"}`}>{String(index + 1).padStart(2, "0")}</span>
              <h3 className={`text-sm font-semibold mt-1 mb-1 ${index === step ? "text-gray-100" : "text-gray-400"}`}>{item.title}</h3>
              <p className="text-xs text-gray-500 leading-relaxed">{item.text}</p>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap justify-center gap-3 mt-8 text-xs text-gray-600">
          <span className="px-3 py-1 rounded-full border border-border/30">Only the app you picked, nothing else on your machine</span>
          <span className="px-3 py-1 rounded-full border border-border/30">Only the friends you linked with</span>
          <span className="px-3 py-1 rounded-full border border-border/30">No upload, no deploy, no tunnel company</span>
        </div>
      </div>
    </section>
  );
}

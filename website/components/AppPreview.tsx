"use client";

import { motion } from "motion/react";
import { useState } from "react";

type Tab = "chat" | "invite" | "burn";

function ChatPreview() {
  return (
    <div className="bg-[#0b141a] rounded-xl overflow-hidden border border-border/30">
      <div className="flex items-center gap-3 px-4 py-3 bg-[#111b21] border-b border-[#1e293b]/60">
        <div className="w-8 h-8 rounded-full bg-linear-to-br from-cyan/30 to-green/30 flex items-center justify-center">
          <span className="text-[10px] font-mono text-cyan">CP</span>
        </div>
        <div className="flex-1">
          <span className="text-sm font-medium text-gray-200 font-mono">crypto_punk</span>
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-green" />
            <span className="text-[10px] text-gray-500">synced 1s ago</span>
          </div>
        </div>
      </div>

      <div className="px-4 py-4 space-y-2 min-h-[280px]">
        <div className="flex justify-start">
          <div className="max-w-[70%] rounded-xl rounded-tl-sm bg-[#202c33] px-3 py-1.5">
            <p className="text-[13px] text-gray-100">Have you tried the burn feature?</p>
            <span className="text-[10px] text-gray-500 float-right mt-0.5">21:03</span>
          </div>
        </div>
        <div className="flex justify-end">
          <div className="max-w-[70%] rounded-xl rounded-tr-sm bg-[#005c4b] px-3 py-1.5">
            <p className="text-[13px] text-gray-100">Not yet! How does it work?</p>
            <div className="flex items-center justify-end gap-1 mt-0.5">
              <span className="text-[10px] text-gray-400">21:03</span>
              <svg className="w-3.5 h-3.5 text-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <polyline points="20 6 9 17 4 12" />
                <polyline points="16 6 5 17" className="opacity-70" />
              </svg>
            </div>
          </div>
        </div>
        <div className="flex justify-start">
          <div className="max-w-[70%] rounded-xl rounded-tl-sm bg-[#202c33] px-3 py-1.5">
            <p className="text-[13px] text-gray-100">It stops republishing your messages to the DHT. They expire naturally in ~5 hours</p>
            <span className="text-[10px] text-gray-500 float-right mt-0.5">21:04</span>
          </div>
        </div>
        <div className="flex justify-end">
          <div className="max-w-[70%] rounded-xl rounded-tr-sm bg-[#005c4b] px-3 py-1.5">
            <p className="text-[13px] text-gray-100">So the messages just... vanish? No trace? 🤯</p>
            <div className="flex items-center justify-end gap-1 mt-0.5">
              <span className="text-[10px] text-gray-400">21:04</span>
              <svg className="w-3.5 h-3.5 text-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <polyline points="20 6 9 17 4 12" />
                <polyline points="16 6 5 17" className="opacity-70" />
              </svg>
            </div>
          </div>
        </div>
        <div className="flex justify-start">
          <div className="max-w-[70%] rounded-xl rounded-tl-sm bg-[#202c33] px-3 py-1.5">
            <p className="text-[13px] text-gray-100">Exactly. Like a real dead drop 💀</p>
            <span className="text-[10px] text-gray-500 float-right mt-0.5">21:04</span>
          </div>
        </div>
      </div>

      <div className="px-4 py-3 bg-[#111b21] border-t border-[#1e293b]/60">
        <div className="flex items-center gap-2">
          <div className="flex-1 h-8 rounded-lg bg-[#202c33] flex items-center px-3">
            <span className="text-xs text-gray-500">Type a message...</span>
          </div>
          <div className="w-8 h-8 rounded-full bg-cyan/20 text-cyan flex items-center justify-center">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

function InvitePreview() {
  return (
    <div className="bg-[#0b141a] rounded-xl overflow-hidden border border-border/30 p-6">
      <div className="text-center mb-6">
        <h4 className="font-mono font-bold text-gray-200 mb-2">Share Invite</h4>
        <p className="text-xs text-gray-500">
          Send this link to your chat partner
        </p>
      </div>

      <div className="flex justify-center mb-6">
        <div className="w-48 h-48 bg-white rounded-xl p-3 flex items-center justify-center">
          <div className="w-full h-full grid grid-cols-7 grid-rows-7 gap-0.5">
            {Array.from({ length: 49 }).map((_, i) => {
              const isCorner =
                (i < 3 || (i >= 4 && i < 7)) ||
                (i >= 42 && i < 45) ||
                (Math.floor(i / 7) < 3 && i % 7 < 3) ||
                (Math.floor(i / 7) < 3 && i % 7 > 3) ||
                (Math.floor(i / 7) > 3 && i % 7 < 3);
              const filled = isCorner || Math.random() > 0.45;
              return (
                <div
                  key={i}
                  className={`rounded-[1px] ${filled ? "bg-gray-900" : "bg-white"}`}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="bg-[#111b21] rounded-lg p-3 mb-4">
        <div className="flex items-center gap-2">
          <div className="flex-1 font-mono text-[10px] text-gray-400 truncate">
            pkarr-chat:///#/chat/a3F2x9...k4M/b7H8y2...pQ/e5K9...wR
          </div>
          <button className="px-3 py-1 rounded bg-cyan/20 text-cyan text-xs font-medium shrink-0">
            Copy
          </button>
        </div>
      </div>

      <div className="text-center">
        <div className="flex items-center justify-center gap-2 text-xs text-gray-500">
          <svg className="w-3.5 h-3.5 text-green" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
          </svg>
          URL fragment never leaves your device
        </div>
      </div>
    </div>
  );
}

function BurnPreview() {
  return (
    <div className="bg-[#0b141a] rounded-xl overflow-hidden border border-border/30 p-6">
      <div className="text-center mb-6">
        <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.048 8.287 8.287 0 009 9.6a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z" />
          </svg>
        </div>
        <h4 className="font-mono font-bold text-gray-200 text-lg mb-2">
          Burn this chat?
        </h4>
        <p className="text-sm text-gray-500 max-w-xs mx-auto leading-relaxed">
          This will stop republishing messages to the DHT. They will expire
          naturally within approximately 5 hours.
        </p>
      </div>

      <div className="space-y-3 max-w-xs mx-auto">
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[#111b21] border border-border/30">
          <svg className="w-5 h-5 text-yellow-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          <span className="text-xs text-gray-400">This action cannot be undone</span>
        </div>

        <div className="flex gap-3">
          <button className="flex-1 py-2.5 rounded-xl border border-border/50 text-gray-400 text-sm font-medium hover:bg-surface-light transition-colors">
            Cancel
          </button>
          <button className="flex-1 py-2.5 rounded-xl bg-red-500/20 text-red-400 text-sm font-medium border border-red-500/30 hover:bg-red-500/30 transition-colors">
            Burn 🔥
          </button>
        </div>
      </div>
    </div>
  );
}

export function AppPreview() {
  const [activeTab, setActiveTab] = useState<Tab>("chat");

  return (
    <section className="relative py-32 px-6">
      <div className="max-w-4xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12"
        >
          <span className="inline-block font-mono text-sm text-cyan mb-4 tracking-wider uppercase">
            Preview
          </span>
          <h2 className="text-4xl sm:text-5xl font-mono font-bold mb-6">
            See it in <span className="text-gradient">action</span>
          </h2>
          <p className="text-lg text-gray-400 max-w-xl mx-auto">
            A familiar interface for a radically different architecture.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <div className="flex justify-center gap-2 mb-8">
            {([
              { id: "chat" as Tab, label: "Chat View" },
              { id: "invite" as Tab, label: "Invite" },
              { id: "burn" as Tab, label: "Burn" },
            ]).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-5 py-2 rounded-lg font-mono text-sm transition-all ${
                  activeTab === tab.id
                    ? "bg-cyan/20 text-cyan border border-cyan/30"
                    : "text-gray-500 hover:text-gray-300 border border-transparent"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="max-w-lg mx-auto"
          >
            {activeTab === "chat" && <ChatPreview />}
            {activeTab === "invite" && <InvitePreview />}
            {activeTab === "burn" && <BurnPreview />}
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}

"use client";

import { motion } from "motion/react";

const messages = [
  {
    id: 1,
    text: "Hey! Check out this new dead drop chat",
    sent: true,
    time: "20:14",
    ack: true,
  },
  {
    id: 2,
    text: "No servers? How does it work?",
    sent: false,
    time: "20:15",
    ack: false,
  },
  {
    id: 3,
    text: "Messages travel through 10M+ DHT nodes, encrypted end-to-end with NaCl secretbox",
    sent: true,
    time: "20:15",
    ack: true,
  },
  {
    id: 4,
    text: "And they vanish when you stop republishing! Truly ephemeral 🔥",
    sent: true,
    time: "20:15",
    ack: true,
  },
  {
    id: 5,
    text: "That's incredible. No accounts either?",
    sent: false,
    time: "20:16",
    ack: false,
  },
  {
    id: 6,
    text: "Zero. Just share a link or QR code. Everything is in the URL fragment — never hits any server",
    sent: true,
    time: "20:16",
    ack: false,
  },
];

const chats = [
  { name: "alice_x92", last: "That's incredible...", unread: 1, time: "20:16" },
  { name: "bob_dev", last: "See you on the DHT", unread: 0, time: "19:42" },
  { name: "crypto_punk", last: "Keys generated ✓", unread: 3, time: "18:30" },
  { name: "anon_7f3a", last: "Burned the chat", unread: 0, time: "17:15" },
];

function CheckIcon({ double }: { double: boolean }) {
  return (
    <svg
      className={`w-4 h-4 ${double ? "text-cyan" : "text-gray-500"}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
      {double && <polyline points="16 6 5 17" className="opacity-70" />}
    </svg>
  );
}

export function MockupApp() {
  return (
    <div className="animate-float">
      <div className="relative rounded-2xl overflow-hidden border border-border/50 glow-cyan bg-[#0b141a] shadow-2xl shadow-cyan/5">
        <div className="flex h-[480px] sm:h-[520px]">
          <div className="w-64 sm:w-72 border-r border-[#1e293b]/60 shrink-0 hidden md:flex flex-col bg-[#111b21]">
            <div className="p-3 border-b border-[#1e293b]/60">
              <div className="flex items-center justify-between mb-3">
                <span className="font-mono text-sm font-bold text-gradient">
                  Dead Drop
                </span>
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-red-500/60" />
                  <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
                  <div className="w-3 h-3 rounded-full bg-green-500/60" />
                </div>
              </div>
              <div className="flex gap-2">
                <div className="flex-1 h-8 rounded-lg bg-[#202c33] flex items-center px-3">
                  <svg
                    className="w-3.5 h-3.5 text-gray-500 mr-2"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <circle cx="11" cy="11" r="8" strokeWidth="2" />
                    <path d="m21 21-4.35-4.35" strokeWidth="2" />
                  </svg>
                  <span className="text-xs text-gray-500">Search chats...</span>
                </div>
                <button className="h-8 px-3 rounded-lg bg-cyan/10 text-cyan text-xs font-medium">
                  + New
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-hidden">
              {chats.map((chat, i) => (
                <div
                  key={chat.name}
                  className={`flex items-center gap-3 px-3 py-3 cursor-pointer transition-colors ${
                    i === 0
                      ? "bg-[#2a3942]"
                      : "hover:bg-[#202c33]"
                  }`}
                >
                  <div className="w-10 h-10 rounded-full bg-linear-to-br from-cyan/30 to-green/30 flex items-center justify-center shrink-0">
                    <span className="text-xs font-mono text-cyan">
                      {chat.name.slice(0, 2).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-200 truncate font-mono">
                        {chat.name}
                      </span>
                      <span className="text-[10px] text-gray-500">
                        {chat.time}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-500 truncate">
                        {chat.last}
                      </span>
                      {chat.unread > 0 && (
                        <span className="w-5 h-5 rounded-full bg-cyan text-[10px] text-black font-bold flex items-center justify-center shrink-0">
                          {chat.unread}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex-1 flex flex-col bg-[#0b141a]">
            <div className="flex items-center gap-3 px-4 py-3 bg-[#111b21] border-b border-[#1e293b]/60">
              <div className="w-9 h-9 rounded-full bg-linear-to-br from-cyan/30 to-green/30 flex items-center justify-center">
                <span className="text-xs font-mono text-cyan">AL</span>
              </div>
              <div className="flex-1">
                <span className="text-sm font-medium text-gray-200 font-mono">
                  alice_x92
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green" />
                  <span className="text-[11px] text-gray-500">
                    synced 3s ago
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 text-gray-500">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" />
                </svg>
              </div>
            </div>

            <div
              className="flex-1 overflow-hidden px-4 py-3 space-y-1.5"
              style={{
                backgroundImage:
                  "radial-gradient(circle at 50% 50%, rgba(34,211,238,0.02) 0%, transparent 70%)",
              }}
            >
              {messages.map((msg, i) => (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 1.6 + i * 0.15, duration: 0.4 }}
                  className={`flex ${msg.sent ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[75%] rounded-xl px-3 py-1.5 ${
                      msg.sent
                        ? "bg-[#005c4b] rounded-tr-sm"
                        : "bg-[#202c33] rounded-tl-sm"
                    }`}
                  >
                    <p className="text-[13px] text-gray-100 leading-relaxed">
                      {msg.text}
                    </p>
                    <div className="flex items-center justify-end gap-1 mt-0.5">
                      <span className="text-[10px] text-gray-400">
                        {msg.time}
                      </span>
                      {msg.sent && <CheckIcon double={msg.ack} />}
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>

            <div className="px-4 py-3 bg-[#111b21] border-t border-[#1e293b]/60">
              <div className="flex items-center gap-2">
                <button className="text-gray-500 hover:text-gray-300">
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                    <circle cx="12" cy="12" r="10" />
                    <path d="M8 14s1.5 2 4 2 4-2 4-2" strokeLinecap="round" />
                    <circle cx="9" cy="10" r="0.5" fill="currentColor" />
                    <circle cx="15" cy="10" r="0.5" fill="currentColor" />
                  </svg>
                </button>
                <div className="flex-1 h-9 rounded-lg bg-[#202c33] flex items-center px-3">
                  <span className="text-sm text-gray-500">
                    Type a message...
                  </span>
                </div>
                <button className="w-9 h-9 rounded-full bg-cyan/20 text-cyan flex items-center justify-center">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

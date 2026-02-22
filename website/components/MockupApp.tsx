"use client";

import { motion } from "motion/react";
import { useState } from "react";

const screenshots = [
  {
    id: "home",
    src: "/screenshots/app-home.png",
    alt: "Ghostly - Home screen",
    label: "Home",
  },
  {
    id: "chat",
    src: "/screenshots/app-new-chat.png",
    alt: "Ghostly - New chat with invite code",
    label: "New Chat",
  },
  {
    id: "conversation",
    src: "/screenshots/app-chat-conversation.png",
    alt: "Ghostly - Chat conversation with GIF",
    label: "Conversation",
  },
  {
    id: "incoming",
    src: "/screenshots/app-incoming-call.png",
    alt: "Ghostly - Incoming call notification",
    label: "Incoming Call",
  },
  {
    id: "call",
    src: "/screenshots/app-audio-call.png",
    alt: "Ghostly - Audio call in progress",
    label: "Audio Call",
  },
];

export function MockupApp() {
  const [activeIndex, setActiveIndex] = useState(2);

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.3 }}
        className="animate-float"
      >
        <div className="relative rounded-2xl overflow-hidden border border-border/50 glow-cyan shadow-2xl shadow-cyan/10">
          <motion.img
            key={screenshots[activeIndex].id}
            src={screenshots[activeIndex].src}
            alt={screenshots[activeIndex].alt}
            className="w-full h-auto"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
          />
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.5 }}
        className="flex justify-center gap-2"
      >
        {screenshots.map((screenshot, index) => (
          <button
            key={screenshot.id}
            onClick={() => setActiveIndex(index)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              activeIndex === index
                ? "bg-green text-[#111b21]"
                : "bg-surface-light text-gray-400 hover:text-gray-200 hover:bg-surface-light/80"
            }`}
          >
            {screenshot.label}
          </button>
        ))}
      </motion.div>
    </div>
  );
}

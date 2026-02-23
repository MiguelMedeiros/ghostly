"use client";

import { motion } from "motion/react";
import { useState, useEffect, useCallback } from "react";

const screenshots = [
  {
    id: "home",
    src: "/screenshots/app-home.png",
    alt: "Ghostly - Home screen with cyan theme",
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
    alt: "Ghostly - Chat conversation with messages and GIF",
    label: "Conversation",
  },
  {
    id: "incoming",
    src: "/screenshots/app-incoming-call.png",
    alt: "Ghostly - Incoming video call notification",
    label: "Incoming Call",
  },
  {
    id: "call",
    src: "/screenshots/app-audio-call.png",
    alt: "Ghostly - Video call in progress",
    label: "Video Call",
  },
  {
    id: "settings",
    src: "/screenshots/app-settings.png",
    alt: "Ghostly - Settings with theme selection",
    label: "Settings",
  },
];

export function MockupApp() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  const nextSlide = useCallback(() => {
    setActiveIndex((prev) => (prev + 1) % screenshots.length);
  }, []);

  useEffect(() => {
    if (isPaused) return;

    const interval = setInterval(nextSlide, 4000);
    return () => clearInterval(interval);
  }, [isPaused, nextSlide]);

  const handleManualSelect = (index: number) => {
    setActiveIndex(index);
    setIsPaused(true);
    setTimeout(() => setIsPaused(false), 8000);
  };

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.3 }}
        className="animate-float"
      >
        <div className="relative rounded-2xl overflow-hidden border border-border/50 glow-cyan shadow-2xl shadow-cyan/10 aspect-[1024/821]">
          {screenshots.map((screenshot, index) => (
            <motion.img
              key={screenshot.id}
              src={screenshot.src}
              alt={screenshot.alt}
              className={`absolute inset-0 w-full h-full object-contain ${
                index === activeIndex ? "z-10" : "z-0"
              }`}
              initial={false}
              animate={{ opacity: index === activeIndex ? 1 : 0 }}
              transition={{ duration: 0.3 }}
            />
          ))}
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
            onClick={() => handleManualSelect(index)}
            className={`relative px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer overflow-hidden ${
              activeIndex === index
                ? "bg-green text-[#111b21]"
                : "bg-surface-light text-gray-400 hover:text-gray-200 hover:bg-surface-light/80"
            }`}
          >
            {activeIndex === index && !isPaused && (
              <motion.div
                className="absolute inset-0 bg-white/20"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 4, ease: "linear" }}
                style={{ transformOrigin: "left" }}
              />
            )}
            <span className="relative z-10">{screenshot.label}</span>
          </button>
        ))}
      </motion.div>
    </div>
  );
}

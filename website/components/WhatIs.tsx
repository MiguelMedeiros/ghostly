"use client";

import { motion, useInView } from "motion/react";
import { useRef, useEffect, useState } from "react";

function AnimatedCounter({
  target,
  suffix = "",
  prefix = "",
  duration = 2,
}: {
  target: number;
  suffix?: string;
  prefix?: string;
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true });
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!isInView) return;
    let start = 0;
    const step = target / (duration * 60);
    const timer = setInterval(() => {
      start += step;
      if (start >= target) {
        setCount(target);
        clearInterval(timer);
      } else {
        setCount(Math.floor(start));
      }
    }, 1000 / 60);
    return () => clearInterval(timer);
  }, [isInView, target, duration]);

  return (
    <span ref={ref} className="tabular-nums">
      {prefix}
      {count.toLocaleString()}
      {suffix}
    </span>
  );
}

const GhostIcon = () => (
  <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/>
    <circle cx="9" cy="9" r="1.5" className="fill-surface"/>
    <circle cx="15" cy="9" r="1.5" className="fill-surface"/>
  </svg>
);

const stats = [
  {
    value: 10,
    suffix: "M+",
    label: "Haunted Nodes",
    description: "Your ghost messages float through the Mainline BitTorrent DHT — the largest haunted network on the planet.",
    icon: (
      <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5a17.92 17.92 0 01-8.716-2.247m0 0A9.015 9.015 0 003 12c0-1.605.42-3.113 1.157-4.418" />
      </svg>
    ),
  },
  {
    value: 0,
    suffix: "",
    label: "Servers to Exorcise",
    description: "No servers to possess, no infrastructure to haunt, no single point of failure. Your ghost roams free.",
    icon: <GhostIcon />,
  },
  {
    value: 256,
    suffix: "-bit",
    label: "Ghost Shield",
    description: "Cloaked with NaCl secretbox encryption. Even other ghosts can't read your messages.",
    icon: (
      <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
      </svg>
    ),
  },
];

const containerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.15 },
  },
};

const cardVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

export function WhatIs() {
  return (
    <section className="relative py-32 px-6">
      <div className="max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-4xl sm:text-5xl font-mono font-bold mb-6">
            What is{" "}
            <span className="text-gradient">Ghostly</span>?
          </h2>
          <p className="text-lg text-gray-400 max-w-2xl mx-auto leading-relaxed">
            A messenger from the spirit realm. Your messages are encrypted on your device,
            float through the DHT as ghostly whispers, and fade away when you close the app
            — leaving no trace behind, just like a proper ghost.
          </p>
        </motion.div>

        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-50px" }}
          className="grid grid-cols-1 md:grid-cols-3 gap-6"
        >
          {stats.map((stat) => (
            <motion.div
              key={stat.label}
              variants={cardVariants}
              className="group relative rounded-2xl border border-border/50 bg-surface p-8 hover:border-cyan/30 transition-all duration-300"
            >
              <div className="absolute inset-0 rounded-2xl bg-linear-to-b from-cyan/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="relative">
                <div className="text-cyan/60 mb-4">{stat.icon}</div>
                <div className="text-5xl font-mono font-bold text-gradient mb-2">
                  {stat.value === 0 ? (
                    "0"
                  ) : (
                    <AnimatedCounter
                      target={stat.value}
                      suffix={stat.suffix}
                    />
                  )}
                </div>
                <div className="text-lg font-semibold text-gray-200 mb-3">
                  {stat.label}
                </div>
                <p className="text-sm text-gray-500 leading-relaxed">
                  {stat.description}
                </p>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

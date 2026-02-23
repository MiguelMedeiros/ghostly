"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { motion } from "motion/react";

interface FloatingGhostData {
  id: number;
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
  opacity: number;
}

function FloatingGhost({
  delay,
  duration,
  size,
  x,
  y,
  opacity,
}: {
  delay: number;
  duration: number;
  size: number;
  x: number;
  y: number;
  opacity: number;
}) {
  return (
    <motion.div
      className="absolute pointer-events-none text-cyan-400"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        width: size,
        height: size,
        filter: size > 40 ? "blur(1px)" : "none",
      }}
      initial={{ opacity: 0, y: 20 }}
      animate={{
        opacity: [0, opacity, opacity, 0],
        y: [20, 0, -30, -60],
        x: [0, 10, -10, 0],
        rotate: [0, 5, -5, 0],
      }}
      transition={{
        duration,
        delay,
        repeat: Infinity,
        ease: "easeInOut",
      }}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
        <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z" />
        <circle cx="9" cy="9" r="1.5" className="fill-[#060a10]" />
        <circle cx="15" cy="9" r="1.5" className="fill-[#060a10]" />
      </svg>
    </motion.div>
  );
}

function GhostParticles() {
  const [ghosts, setGhosts] = useState<FloatingGhostData[]>([]);

  useEffect(() => {
    setGhosts(
      Array.from({ length: 25 }, (_, i) => ({
        id: i,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: 20 + Math.random() * 50,
        delay: Math.random() * 10,
        duration: 8 + Math.random() * 10,
        opacity: 0.06 + Math.random() * 0.12,
      }))
    );
  }, []);

  if (ghosts.length === 0) return null;

  return (
    <div className="absolute inset-0 overflow-hidden">
      {ghosts.map((ghost) => (
        <FloatingGhost key={ghost.id} {...ghost} />
      ))}
    </div>
  );
}

export default function NotFound() {
  const [ghostPosition, setGhostPosition] = useState({ x: 0, y: 0 });
  const [isSearching, setIsSearching] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setGhostPosition({
        x: Math.sin(Date.now() / 1000) * 20,
        y: Math.cos(Date.now() / 800) * 15,
      });
    }, 50);

    const searchInterval = setInterval(() => {
      setIsSearching((prev) => !prev);
    }, 2000);

    return () => {
      clearInterval(interval);
      clearInterval(searchInterval);
    };
  }, []);

  return (
    <main className="min-h-screen bg-[#060a10] flex flex-col items-center justify-center px-4 relative overflow-hidden">
      {/* Background grid */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(34,211,238,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(34,211,238,0.03)_1px,transparent_1px)] bg-[size:50px_50px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_70%)]" />

      {/* Floating ghost particles */}
      <GhostParticles />

      {/* Main content */}
      <div className="relative z-10 text-center max-w-2xl mx-auto">
        {/* Ghost with flashlight */}
        <div
          className="relative inline-block mb-8"
          style={{
            transform: `translate(${ghostPosition.x}px, ${ghostPosition.y}px)`,
          }}
        >
          <svg
            width="120"
            height="150"
            viewBox="0 0 80 100"
            className="relative z-10"
          >
            <defs>
              <filter id="ghost-glow-404">
                <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                <feMerge>
                  <feMergeNode in="coloredBlur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <radialGradient id="flashlight-beam" cx="0%" cy="50%" r="100%">
                <stop offset="0%" stopColor="rgba(250, 204, 21, 0.4)" />
                <stop offset="50%" stopColor="rgba(250, 204, 21, 0.1)" />
                <stop offset="100%" stopColor="transparent" />
              </radialGradient>
            </defs>

            {/* Flashlight beam */}
            <ellipse
              cx="75"
              cy="45"
              rx="60"
              ry="25"
              fill="url(#flashlight-beam)"
              className={`transition-opacity duration-500 ${
                isSearching ? "opacity-100" : "opacity-40"
              }`}
              style={{
                transformOrigin: "40px 45px",
                animation: "searchBeam 3s ease-in-out infinite",
              }}
            />

            {/* Ghost body */}
            <path
              d="M40 8 C18 8 8 22 8 40 L8 72 L16 64 L24 72 L32 64 L40 72 L48 64 L56 72 L64 64 L72 72 L72 40 C72 22 62 8 40 8Z"
              fill="#22d3ee"
              filter="url(#ghost-glow-404)"
            />

            {/* Worried/searching eyes */}
            <g className="animate-blink">
              <ellipse cx="29" cy="36" rx="6" ry="7" fill="#0f172a" />
              <ellipse cx="51" cy="36" rx="6" ry="7" fill="#0f172a" />
              <circle cx="31" cy="34" r="2" fill="white" />
              <circle cx="53" cy="34" r="2" fill="white" />
            </g>

            {/* Worried mouth */}
            <path
              d="M32 52 Q40 48 48 52"
              stroke="#0f172a"
              strokeWidth="3"
              fill="none"
              strokeLinecap="round"
            />

            {/* Little flashlight in hand */}
            <rect x="58" y="40" width="12" height="8" rx="2" fill="#fcd34d" />
            <rect x="68" y="41" width="6" height="6" rx="1" fill="#fef3c7" />
          </svg>

          {/* Question marks floating around */}
          <span
            className="absolute -top-2 -right-4 text-cyan-400/60 text-2xl animate-bounce"
            style={{ animationDelay: "0s" }}
          >
            ?
          </span>
          <span
            className="absolute top-8 -left-6 text-cyan-400/40 text-xl animate-bounce"
            style={{ animationDelay: "0.3s" }}
          >
            ?
          </span>
          <span
            className="absolute -bottom-2 right-0 text-cyan-400/50 text-lg animate-bounce"
            style={{ animationDelay: "0.6s" }}
          >
            ?
          </span>
        </div>

        {/* 404 text */}
        <h1 className="text-8xl md:text-9xl font-bold mb-4 tracking-tighter">
          <span className="bg-gradient-to-r from-cyan-400 via-cyan-300 to-cyan-500 bg-clip-text text-transparent">
            4
          </span>
          <span className="relative inline-block mx-2">
            <span className="bg-gradient-to-r from-cyan-300 to-cyan-400 bg-clip-text text-transparent opacity-50">
              0
            </span>
            <svg
              className="absolute inset-0 w-full h-full"
              viewBox="0 0 100 100"
            >
              <circle
                cx="50"
                cy="50"
                r="40"
                fill="none"
                stroke="rgba(34, 211, 238, 0.3)"
                strokeWidth="2"
                strokeDasharray="10 5"
                className="animate-spin-slow"
              />
            </svg>
          </span>
          <span className="bg-gradient-to-r from-cyan-500 via-cyan-300 to-cyan-400 bg-clip-text text-transparent">
            4
          </span>
        </h1>

        <h2 className="text-2xl md:text-3xl font-semibold text-gray-200 mb-4">
          This page vanished into the DHT
        </h2>

        <p className="text-gray-400 text-lg mb-8 max-w-md mx-auto">
          Like an ephemeral message, this page has disappeared. Our ghost is
          searching through 10M+ nodes but can&apos;t find it.
        </p>

        {/* Terminal-style message */}
        <div className="bg-gray-900/50 border border-cyan-500/20 rounded-lg p-4 mb-8 font-mono text-sm max-w-md mx-auto">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-3 h-3 rounded-full bg-red-500/80" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
            <div className="w-3 h-3 rounded-full bg-green-500/80" />
          </div>
          <div className="text-left text-gray-400">
            <span className="text-cyan-400">$</span> ghostly find /page
            <br />
            <span className="text-red-400">
              Error: Page not found in DHT network
            </span>
            <br />
            <span className="text-gray-500">
              Searched 10,847,293 nodes... nothing.
            </span>
            <br />
            <span className="text-cyan-400">$</span>{" "}
            <span className="animate-pulse">▌</span>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/"
            className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-cyan-500 hover:bg-cyan-400 text-gray-900 font-semibold rounded-lg transition-all hover:scale-105 hover:shadow-lg hover:shadow-cyan-500/25"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
              />
            </svg>
            Go Home
          </Link>

          <Link
            href="/docs"
            className="inline-flex items-center justify-center gap-2 px-6 py-3 border border-cyan-500/30 hover:border-cyan-500/60 text-cyan-400 font-semibold rounded-lg transition-all hover:bg-cyan-500/10"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
              />
            </svg>
            Read Docs
          </Link>
        </div>
      </div>

      {/* Animated ghost shadows at bottom */}
      <div className="absolute bottom-0 left-0 right-0 h-32 pointer-events-none">
        <div className="absolute bottom-10 left-1/4 w-16 h-8 bg-cyan-400/5 rounded-full blur-xl animate-pulse" />
        <div
          className="absolute bottom-8 right-1/3 w-20 h-10 bg-cyan-400/5 rounded-full blur-xl animate-pulse"
          style={{ animationDelay: "1s" }}
        />
        <div
          className="absolute bottom-12 left-1/2 w-12 h-6 bg-cyan-400/5 rounded-full blur-xl animate-pulse"
          style={{ animationDelay: "0.5s" }}
        />
      </div>

      <style jsx global>{`
        @keyframes searchBeam {
          0%,
          100% {
            transform: rotate(-15deg);
          }
          50% {
            transform: rotate(15deg);
          }
        }

        @keyframes spin-slow {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }

        @keyframes blink {
          0%,
          90%,
          100% {
            transform: scaleY(1);
          }
          95% {
            transform: scaleY(0.1);
          }
        }

        .animate-spin-slow {
          animation: spin-slow 20s linear infinite;
        }

        .animate-blink {
          animation: blink 4s ease-in-out infinite;
        }
      `}</style>
    </main>
  );
}

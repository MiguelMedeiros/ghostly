"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { GHOST_PATH } from "@/components/ghost/Ghost";
import { useCalm } from "@/lib/useCalm";

interface FloatingGhostData {
  id: number;
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
  opacity: number;
}

// The floater's drift is a CSS keyframe on its HTML box (transform and opacity only), so it plays on the compositor:
// stepped by script, 25 of them restyled the page at every frame, forever. Its own faintness sits on the SVG, still.
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
    <div
      className="nf-floater absolute pointer-events-none text-cyan-400"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        width: size,
        height: size,
        filter: size > 40 ? "blur(1px)" : "none",
        animationDuration: `${duration}s`,
        animationDelay: `${delay}s`,
      }}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full" opacity={opacity}>
        <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z" />
        <circle cx="9" cy="9" r="1.5" className="fill-[#060a10]" />
        <circle cx="15" cy="9" r="1.5" className="fill-[#060a10]" />
      </svg>
    </div>
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

/**
 * Everything that moves here is a CSS animation of `transform` or `opacity` on an HTML box (an outer `<svg>` is one),
 * so it plays on the compositor and the page lays nothing out while it is open. A CSS transform on a shape inside an
 * SVG is not composited: it restyles and lays out the page at every frame. Reduced motion: a still (no ghost floats
 * by, and site.css ends every animation at once).
 */
export function NotFoundScene() {
  const calm = useCalm();

  return (
    <main className="min-h-screen bg-[#060a10] flex flex-col items-center justify-center px-4 relative overflow-hidden">
      {/* Background grid */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(34,211,238,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(34,211,238,0.03)_1px,transparent_1px)] bg-[size:50px_50px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_70%)]" />

      {/* Floating ghost particles */}
      {!calm && <GhostParticles />}

      {/* Main content */}
      <div className="relative z-10 text-center max-w-2xl mx-auto">
        {/* Ghost with flashlight. It wanders on two axes at two paces, one wrapper each. */}
        <div className="nf-wander-x relative inline-block mb-8">
          <div className="nf-wander-y relative">
            {/* Flashlight beam: it sweeps and dims in boxes of its own, under the ghost, clipped to the ghost's box. */}
            <div className="nf-search absolute inset-0 overflow-hidden">
              <svg
                width="120"
                height="150"
                viewBox="0 0 80 100"
                overflow="visible"
                className="nf-sweep absolute inset-0"
              >
                <defs>
                  <radialGradient id="flashlight-beam" cx="0%" cy="50%" r="100%">
                    <stop offset="0%" stopColor="rgba(250, 204, 21, 0.4)" />
                    <stop offset="50%" stopColor="rgba(250, 204, 21, 0.1)" />
                    <stop offset="100%" stopColor="transparent" />
                  </radialGradient>
                </defs>
                <ellipse cx="75" cy="45" rx="60" ry="25" fill="url(#flashlight-beam)" />
              </svg>
            </div>

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
              </defs>

              {/* Ghost body */}
              <path
                d={GHOST_PATH}
                fill="#22d3ee"
                filter="url(#ghost-glow-404)"
              />

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

            {/* Worried/searching eyes: a layer of their own over the ghost, so the blink is the layer's. */}
            <svg
              width="120"
              height="150"
              viewBox="0 0 80 100"
              className="animate-blink absolute inset-0 z-10"
            >
              <ellipse cx="29" cy="36" rx="6" ry="7" fill="#0f172a" />
              <ellipse cx="51" cy="36" rx="6" ry="7" fill="#0f172a" />
              <circle cx="31" cy="34" r="2" fill="white" />
              <circle cx="53" cy="34" r="2" fill="white" />
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
              className="animate-spin-slow absolute inset-0 w-full h-full"
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
          Like a ghost, this page has slipped away. Our ghost is searching
          through 10M+ nodes but can&apos;t find it.
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
            href="/wisps"
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
            Read the WISPs
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
        .nf-wander-x {
          animation: nf-wander-x 3.14s -1.57s ease-in-out infinite alternate;
        }
        .nf-wander-y {
          animation: nf-wander-y 2.51s ease-in-out infinite alternate;
        }
        @keyframes nf-wander-x {
          from {
            transform: translateX(-20px);
          }
          to {
            transform: translateX(20px);
          }
        }
        @keyframes nf-wander-y {
          from {
            transform: translateY(15px);
          }
          to {
            transform: translateY(-15px);
          }
        }

        /* The beam swings about the flashlight (40, 45 in the ghost's 80x100 box, drawn at 1.5x). */
        .nf-sweep {
          transform-origin: 60px 67.5px;
          animation: searchBeam 3s ease-in-out infinite;
        }
        /* Bright for 2 s, dim for 2 s, half a second to change. */
        .nf-search {
          animation: nf-search 4s linear infinite;
        }
        @keyframes nf-search {
          0%,
          50% {
            opacity: 1;
          }
          62.5%,
          87.5% {
            opacity: 0.4;
          }
          100% {
            opacity: 1;
          }
        }

        /* Each ghost floats by twice, then the background is still: the last is gone within a minute. */
        .nf-floater {
          animation-name: nf-float;
          animation-timing-function: ease-in-out;
          animation-iteration-count: 2;
          animation-fill-mode: both;
        }
        @keyframes nf-float {
          0% {
            opacity: 0;
            transform: translate(0, 20px) rotate(0deg);
          }
          33.333% {
            opacity: 1;
            transform: translate(10px, 0) rotate(5deg);
          }
          66.667% {
            opacity: 1;
            transform: translate(-10px, -30px) rotate(-5deg);
          }
          100% {
            opacity: 0;
            transform: translate(0, -60px) rotate(0deg);
          }
        }

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

        /* The lids close on the eyes' line (y 36 of 100). */
        .animate-blink {
          transform-origin: 50% 36%;
          animation: blink 4s ease-in-out infinite;
        }
      `}</style>
    </main>
  );
}

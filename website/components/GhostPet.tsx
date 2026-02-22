"use client";

import { useEffect, useRef, useState } from "react";

type GhostMood = "sleeping" | "bored" | "happy" | "tired";

export default function GhostPet() {
  const [position, setPosition] = useState({ x: 100, y: 100 });
  const [mood, setMood] = useState<GhostMood>("sleeping");
  const [direction, setDirection] = useState<"left" | "right">("right");
  const [isVisible, setIsVisible] = useState(true);
  const [isHiding, setIsHiding] = useState(false);
  
  const mousePos = useRef({ x: 200, y: 200 });
  const lastMouseMove = useRef(Date.now());
  const mouseSpeed = useRef(0);
  const lastMousePos = useRef({ x: 0, y: 0 });
  const currentPos = useRef({ x: 100, y: 100 });
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const now = Date.now();
      const timeDelta = now - lastMouseMove.current;

      if (timeDelta > 0) {
        const dx = e.clientX - lastMousePos.current.x;
        const dy = e.clientY - lastMousePos.current.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        mouseSpeed.current = distance / timeDelta;
      }

      lastMousePos.current = { x: e.clientX, y: e.clientY };
      // Store viewport-relative position only (no scroll offset)
      mousePos.current = { 
        x: e.clientX, 
        y: e.clientY 
      };
      lastMouseMove.current = now;
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  useEffect(() => {
    let animationId: number;

    const animate = () => {
      const now = Date.now();
      const timeSinceLastMove = now - lastMouseMove.current;

      const targetX = mousePos.current.x + 50;
      const targetY = mousePos.current.y + 30;

      const dx = targetX - currentPos.current.x;
      const dy = targetY - currentPos.current.y;
      const distanceToTarget = Math.sqrt(dx * dx + dy * dy);

      // Check if mouse is close to ghost (using absolute coordinates)
      const ghostCenterX = currentPos.current.x + 18;
      const ghostCenterY = currentPos.current.y + 22;
      const mouseAbsX = mousePos.current.x;
      const mouseAbsY = mousePos.current.y;
      const mouseToGhostDistance = Math.sqrt(
        Math.pow(mouseAbsX - ghostCenterX, 2) +
        Math.pow(mouseAbsY - ghostCenterY, 2)
      );

      if (mouseToGhostDistance < 60 && !isHiding) {
        setIsHiding(true);
        if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = setTimeout(() => {
          setIsHiding(false);
        }, 1200);
      }

      // Determine mood
      let newMood: GhostMood;
      if (timeSinceLastMove > 4000) {
        newMood = "sleeping";
      } else if (timeSinceLastMove > 2000) {
        newMood = "bored";
      } else if (mouseSpeed.current > 1.0) {
        newMood = "tired";
      } else {
        newMood = "happy";
      }
      setMood(newMood);

      // Calculate speed based on mood
      const speed = newMood === "tired" ? 0.004 : newMood === "sleeping" ? 0.002 : 0.008;

      // Update position (clamped to viewport to prevent overflow)
      const ghostWidth = 36;
      const ghostHeight = 45;
      const maxX = window.innerWidth - ghostWidth - 10;
      const maxY = window.innerHeight - ghostHeight - 10;
      
      const newX = Math.max(0, Math.min(maxX, currentPos.current.x + dx * speed));
      const newY = Math.max(0, Math.min(maxY, currentPos.current.y + dy * speed));
      
      currentPos.current = { x: newX, y: newY };
      setPosition({ x: newX, y: newY });

      // Update direction
      if (dx > 5) setDirection("right");
      else if (dx < -5) setDirection("left");

      animationId = requestAnimationFrame(animate);
    };

    animationId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationId);
  }, [isHiding]);

  if (!isVisible) return null;

  return (
    <div
      className="fixed pointer-events-none z-50"
      style={{
        left: position.x,
        top: position.y,
        transform: `scaleX(${direction === "left" ? -1 : 1}) ${isHiding ? "scale(0.2)" : "scale(1)"}`,
        opacity: isHiding ? 0 : 0.2,
        transition: "opacity 0.2s, transform 0.2s",
      }}
    >
      <div className="relative">
        <svg
          width="36"
          height="45"
          viewBox="0 0 80 100"
          style={{
            animation: mood === "sleeping" 
              ? "ghostFloat 6s ease-in-out infinite" 
              : mood === "happy"
              ? "ghostFloat 3s ease-in-out infinite"
              : "ghostFloat 4s ease-in-out infinite"
          }}
        >
          <defs>
            <filter id="ghost-glow">
              <feGaussianBlur stdDeviation="2" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <path
            d="M40 8 C18 8 8 22 8 40 L8 72 L16 64 L24 72 L32 64 L40 72 L48 64 L56 72 L64 64 L72 72 L72 40 C72 22 62 8 40 8Z"
            fill="#22d3ee"
            filter="url(#ghost-glow)"
          />

          {mood === "sleeping" && (
            <g>
              <path d="M24 36 Q29 34 34 36" stroke="#0f172a" strokeWidth="3" fill="none" strokeLinecap="round" />
              <path d="M46 36 Q51 34 56 36" stroke="#0f172a" strokeWidth="3" fill="none" strokeLinecap="round" />
              <text x="62" y="24" fontSize="12" fill="rgba(34, 211, 238, 0.8)" style={{ animation: "zzzFloat 2s ease-in-out infinite" }}>z</text>
              <text x="68" y="16" fontSize="10" fill="rgba(34, 211, 238, 0.6)" style={{ animation: "zzzFloat 2s ease-in-out infinite 0.3s" }}>z</text>
              <text x="72" y="10" fontSize="8" fill="rgba(34, 211, 238, 0.4)" style={{ animation: "zzzFloat 2s ease-in-out infinite 0.6s" }}>z</text>
            </g>
          )}

          {mood === "bored" && (
            <g>
              <circle cx="29" cy="36" r="5" fill="#0f172a" />
              <circle cx="51" cy="36" r="5" fill="#0f172a" />
              <circle cx="30" cy="34" r="1.5" fill="white" />
              <circle cx="52" cy="34" r="1.5" fill="white" />
            </g>
          )}

          {mood === "happy" && (
            <g>
              <circle cx="29" cy="36" r="6" fill="#0f172a" />
              <circle cx="51" cy="36" r="6" fill="#0f172a" />
              <circle cx="30" cy="34" r="2" fill="white" />
              <circle cx="52" cy="34" r="2" fill="white" />
            </g>
          )}

          {mood === "tired" && (
            <g>
              <path d="M22 32 L36 36" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" />
              <path d="M44 36 L58 32" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" />
              <circle cx="29" cy="40" r="4" fill="#0f172a" />
              <circle cx="51" cy="40" r="4" fill="#0f172a" />
              <circle cx="30" cy="38" r="1.5" fill="white" />
              <circle cx="52" cy="38" r="1.5" fill="white" />
            </g>
          )}
        </svg>

        <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-6 h-1.5 bg-cyan-400/20 rounded-full blur-sm" />
      </div>

      <button
        onClick={() => setIsVisible(false)}
        className="absolute -top-1 -right-1 w-4 h-4 bg-gray-800/50 rounded-full text-[10px] text-gray-500 hover:text-white pointer-events-auto opacity-0 hover:opacity-100 transition-opacity"
        aria-label="Hide ghost"
      >
        ×
      </button>

      <style jsx global>{`
        @keyframes ghostFloat {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }

        @keyframes zzzFloat {
          0%, 100% { opacity: 0.3; transform: translateY(0); }
          50% { opacity: 1; transform: translateY(-4px); }
        }
      `}</style>
    </div>
  );
}

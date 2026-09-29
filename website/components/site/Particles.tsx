import { GhostMark } from "@/components/ghost/Ghost";

/**
 * The original backdrop: small ghosts rising and fading. Positions come from a
 * fixed sequence so server and client render the same thing; CSS runs the loop
 * and reduced motion hides it.
 */
function seeded(n: number) {
  let s = 7;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  return Array.from({ length: n }, (_, id) => ({
    id,
    x: r() * 100,
    y: 8 + r() * 84,
    size: 18 + r() * 44,
    delay: -r() * 14,
    duration: 9 + r() * 9,
    opacity: 0.05 + r() * 0.11,
  }));
}

export function Particles({ count = 22, tone = "cyan" }: { count?: number; tone?: "cyan" | "mix" }) {
  return (
    <div className="particles" aria-hidden="true">
      {seeded(count).map((g) => (
        <span
          key={g.id}
          style={
            {
              left: `${g.x}%`,
              top: `${g.y}%`,
              width: g.size,
              height: g.size,
              filter: g.size > 44 ? "blur(1px)" : undefined,
              color: tone === "mix" && g.id % 3 === 0 ? "var(--mint)" : undefined,
              "--d": `${g.duration}s`,
              "--delay": `${g.delay}s`,
              "--o": g.opacity,
            } as React.CSSProperties
          }
        >
          <GhostMark />
        </span>
      ))}
    </div>
  );
}

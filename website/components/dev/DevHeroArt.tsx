import { Ghost } from "@/components/ghost/Ghost";

// An isometric Ghost core with the pieces docking around it on a slow CSS
// loop (9s). Boo and Casper stand on the core. Under reduced motion the
// pieces sit docked from the first frame (see .dv-piece in developers.css).
const PIECES = [
  { x: -212, y: -62, c: "#60a5fa", label: "webrtc/1" },
  { x: 212, y: -62, c: "#a78bfa", label: "chat/1" },
  { x: -212, y: 108, c: "#fbbf24", label: "payments/1" },
  { x: 212, y: 108, c: "#4ade80", label: "files/2" },
  { x: 0, y: 200, c: "#2dd4bf", label: "services" },
];

function Tile({ c, w = 70, h = 12 }: { c: string; w?: number; h?: number }) {
  const d = w / 2;
  return (
    <g>
      <path d={`M${-w} 0 L0 ${d} L0 ${d + h} L${-w} ${h} Z`} fill={c} fillOpacity="0.35" stroke={c} strokeOpacity="0.7" />
      <path d={`M${w} 0 L0 ${d} L0 ${d + h} L${w} ${h} Z`} fill={c} fillOpacity="0.2" stroke={c} strokeOpacity="0.7" />
      <path d={`M0 ${-d} L${w} 0 L0 ${d} L${-w} 0 Z`} fill={c} fillOpacity="0.18" stroke={c} strokeWidth="1.5" />
    </g>
  );
}

export function DevHeroArt() {
  return (
    <div className="dv-art" aria-hidden="true">
      <svg viewBox="-300 -230 600 490" className="stage dv-art-svg">
        <g className="dv-core">
          {/* 1.4x the old 110x34 core */}
          <Tile c="#22d3ee" w={154} h={48} />
          <text x="0" y="26" textAnchor="middle" fontSize="19" fill="#e8edf5" className="mono">
            Ghost
          </text>
        </g>
        {PIECES.map((p, i) => (
          <g key={p.label} className="dv-piece" style={{ "--dx": `${p.x}px`, "--dy": `${p.y}px`, animationDelay: `${i * -1.8}s` } as React.CSSProperties}>
            <Tile c={p.c} w={58} h={12} />
            <text x="0" y="4" textAnchor="middle" fontSize="11" fill="#e8edf5" className="mono">
              {p.label}
            </text>
          </g>
        ))}
        {/* Two soft contact shadows keep the ghosts on the tile instead of floating above it. */}
        <ellipse cx="-42" cy="-16" rx="26" ry="6" fill="#22d3ee" fillOpacity="0.22" />
        <ellipse cx="42" cy="-16" rx="26" ry="6" fill="#4ade80" fillOpacity="0.22" />
        <g transform="translate(-74 -84)">
          <Ghost who="boo" size={64} mood="happy" float={false} look={{ x: 1, y: 0.6 }} />
        </g>
        <g transform="translate(10 -84)">
          <Ghost who="casper" size={64} mood="wink" float={false} phase={1} look={{ x: -1, y: 0.6 }} />
        </g>
      </svg>
    </div>
  );
}

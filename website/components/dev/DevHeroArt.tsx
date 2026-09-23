import { Ghost } from "@/components/ghost/Ghost";

// An isometric core with pieces docking around it, on a slow CSS loop.
const PIECES = [
  { x: -150, y: -40, c: "#60a5fa", label: "webrtc/1" },
  { x: 150, y: -40, c: "#a78bfa", label: "chat/1" },
  { x: -150, y: 90, c: "#fbbf24", label: "payments/1" },
  { x: 150, y: 90, c: "#4ade80", label: "files/2" },
  { x: 0, y: 165, c: "#2dd4bf", label: "services" },
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
    <div className="devhero-art" aria-hidden="true">
      <svg viewBox="-300 -230 600 480" className="stage">
        <g className="devhero-core">
          <Tile c="#22d3ee" w={110} h={34} />
          <text x="0" y="6" textAnchor="middle" fontSize="15" fill="#e8edf5" className="mono">
            Ghost
          </text>
        </g>
        {PIECES.map((p, i) => (
          <g key={p.label} className="devhero-piece" style={{ "--dx": `${p.x}px`, "--dy": `${p.y}px`, animationDelay: `${i * -1.4}s` } as React.CSSProperties}>
            <Tile c={p.c} w={58} h={12} />
            <text x="0" y="4" textAnchor="middle" fontSize="11" fill="#e8edf5" className="mono">
              {p.label}
            </text>
          </g>
        ))}
        <g transform="translate(-58 -150)">
          <Ghost who="boo" size={52} mood="happy" float={false} look={{ x: 1, y: 0.6 }} />
        </g>
        <g transform="translate(8 -150)">
          <Ghost who="casper" size={52} mood="wink" float={false} phase={1} look={{ x: -1, y: 0.6 }} />
        </g>
      </svg>
    </div>
  );
}

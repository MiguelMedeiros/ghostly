"use client";

import { useId } from "react";
import { GhostShape } from "../icons";
import { appear, beat, mix, sampleStory } from "./timeline";

function Lock({
  x = 0,
  y = 0,
  scale = 1,
}: {
  x?: number;
  y?: number;
  scale?: number;
}) {
  return (
    <g
      transform={`translate(${x} ${y}) scale(${scale})`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    >
      <path d="M-5-2v-4a5 5 0 0 1 10 0v4" />
      <rect x="-8" y="-2" width="16" height="13" rx="3" />
      <path d="M0 3v3" />
    </g>
  );
}
function Key({ x, y }: { x: number; y: number }) {
  return (
    <g
      transform={`translate(${x} ${y})`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="-6" cy="0" r="6" />
      <path d="M0 0h17m-5 0v5m5-5v4" />
    </g>
  );
}

// The original flat mark keeps its silhouette throughout the story.
function Ghost({
  x,
  y,
  scale,
  opacity,
  peer,
  t,
  compact,
}: {
  x: number;
  y: number;
  scale: number;
  opacity: number;
  peer: number;
  t: number;
  compact: boolean;
}) {
  const travel = Math.sin(beat(t, 0.88, 1.32) * Math.PI);
  // Follow the invitation, glance up at discovery, then meet each other's gaze.
  const lookX = (peer ? -1 : 1) * 0.65 * beat(t, 1.1, 1.7);
  const lookY = -0.6 * beat(t, 2.05, 2.6) * (1 - beat(t, 3.5, 4.3));
  return (
    <g
      opacity={opacity}
      data-peer={peer ? "casper" : "boo"}
      transform={`translate(${x} ${y}) scale(${scale})`}
    >
      <ellipse
        cy="111"
        rx="57"
        ry="5"
        fill={peer ? "#99d7b8" : "#8bcfe0"}
        opacity=".08"
      />
      <g
        transform={`rotate(${travel * (peer ? -4 : 4)}) translate(-96 -88) scale(8)`}
        fill={peer ? "#bbd8ae" : "#9fdedb"}
      >
        <GhostShape lookX={lookX} lookY={lookY} />
      </g>
      <text
        y="139"
        opacity={beat(t, 0.95, 1.3)}
        textAnchor="middle"
        className="film-label"
        fontSize={compact ? 19 : 12}
      >
        {peer ? "CASPER" : "BOO"}
      </text>
    </g>
  );
}

const nodes = [
  [175, 76],
  [350, 65],
  [620, 55],
  [820, 105],
  [100, 225],
  [300, 240],
  [540, 220],
  [760, 240],
  [875, 325],
  [180, 355],
  [400, 365],
  [600, 365],
];
const edges = [
  [0, 1],
  [1, 2],
  [2, 3],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [4, 9],
  [5, 10],
  [6, 11],
  [8, 11],
  [9, 10],
  [10, 11],
];
const records = [
  { x: 350, y: 65, peer: 0, key: "b7a4…9f2c" },
  { x: 400, y: 365, peer: 0, key: "b7a4…9f2c" },
  { x: 600, y: 365, peer: 1, key: "c2e8…4a1b" },
  { x: 620, y: 55, peer: 1, key: "c2e8…4a1b" },
];

export function StoryIllustration({
  time,
  compact = false,
  finale = false,
}: {
  time: number;
  compact?: boolean;
  finale?: boolean;
}) {
  const id = useId();
  const t = finale ? 4.8 : time;
  const s = sampleStory(t, compact);
  const recordFocus = beat(t, 3.06, 3.4);
  const recordOpacity = appear(t, 2.07, 4.04, 0.18);
  const linkPath = `M${s.boo.x + 66} ${s.boo.y + 14} C${s.boo.x + 145} ${s.connectionY},${s.casper.x - 145} ${s.connectionY},${s.casper.x - 66} ${s.casper.y + 14}`;
  const textSize = compact ? 20 : 12;
  return (
    <svg
      className={`film-world${finale ? " film-world-finale" : ""}`}
      viewBox={compact ? "80 -5 840 610" : "0 0 1000 450"}
      aria-hidden="true"
      focusable="false"
      data-story-time={t.toFixed(3)}
    >
      <defs>
        <linearGradient id={`${id}-line`}>
          <stop stopColor="#80d0db" />
          <stop offset="1" stopColor="#b6d9a8" />
        </linearGradient>
        <radialGradient id={`${id}-halo`}>
          <stop stopColor="#70bbaa" stopOpacity=".14" />
          <stop offset="1" stopColor="#70bbaa" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse
        cx="500"
        cy={compact ? 300 : 270}
        rx="430"
        ry="230"
        fill={`url(#${id}-halo)`}
      />
      <g opacity={s.network}>
        {edges.map(([a, b]) => (
          <path
            key={`${a}-${b}`}
            d={`M${nodes[a][0]} ${nodes[a][1]}L${nodes[b][0]} ${nodes[b][1]}`}
            fill="none"
            stroke="#86baab"
            strokeOpacity=".17"
            strokeWidth="1"
          />
        ))}
        {nodes.map(([x, y], i) => (
          <g key={i}>
            <circle
              cx={x}
              cy={y}
              r="12"
              fill="#10251f"
              stroke="#719887"
              strokeOpacity=".35"
            />
            <circle cx={x} cy={y} r="3" fill="#a0c3b2" opacity=".7" />
          </g>
        ))}
        <text
          x="500"
          y={compact ? 607 : 426}
          textAnchor="middle"
          className="film-label"
          fontSize={textSize}
        >
          DISTRIBUTED HASH TABLE · NO CENTRAL INBOX
        </text>
      </g>
      <g opacity={s.connection}>
        <path
          d={linkPath}
          stroke={`url(#${id}-line)`}
          strokeWidth="14"
          opacity=".045"
          fill="none"
        />
        <path
          data-connection-path
          d={linkPath}
          pathLength="1"
          stroke={`url(#${id}-line)`}
          strokeWidth="1.7"
          strokeDasharray="1"
          strokeDashoffset={1 - s.connection}
          fill="none"
        />
        <circle cx={s.boo.x + 66} cy={s.boo.y + 14} r="3" fill="#95dbe0" />
        <circle
          cx={s.casper.x - 66}
          cy={s.casper.y + 14}
          r="3"
          fill="#bfd8ad"
        />
      </g>
      <g opacity={recordOpacity}>
        {records.map((record, i) => {
          const origin = record.peer ? s.casper : s.boo;
          const publish = beat(t, 2.15 + i * 0.08, 2.52 + i * 0.08);
          const focus = i === 0 ? recordFocus : 0;
          const x = mix(mix(origin.x, record.x, publish), 500, focus);
          const y = mix(
            mix(origin.y, record.y, publish),
            compact ? 190 : 173,
            focus,
          );
          const size = mix(compact ? 1.2 : 0.9, compact ? 2.25 : 1.9, focus);
          const opacity =
            beat(t, 2.12 + i * 0.08, 2.24 + i * 0.08) *
            (i === 0 ? 1 : 1 - recordFocus * 0.8);
          return (
            <g
              key={i}
              opacity={opacity}
              transform={`translate(${x} ${y}) scale(${size})`}
              color={record.peer ? "#c5dbb0" : "#a8dde0"}
              data-record={i}
            >
              <rect
                x="-64"
                y="-25"
                width="128"
                height="50"
                rx="8"
                fill="#10201e"
                stroke="currentColor"
                strokeOpacity=".45"
              />
              <g opacity={i === 0 ? 1 - s.decrypt : 1}>
                <Lock x={-42} y={-1} scale={0.7} />
                <text
                  x="-26"
                  y="4"
                  fontSize="11"
                  fill="currentColor"
                  className="film-mono"
                >
                  {record.key}
                </text>
              </g>
              {i === 0 && (
                <g opacity={s.decrypt}>
                  <text y="-2" textAnchor="middle" fill="#e1f1df" fontSize="11">
                    Boo. I found you.
                  </text>
                  <text
                    y="13"
                    textAnchor="middle"
                    fontSize="6"
                    className="film-label"
                  >
                    DECRYPTED ON YOUR DEVICE
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </g>
      <g opacity={appear(t, 3.25, 3.98)} color="#c4dfb2">
        <g opacity={1 - s.decrypt}>
          <Key
            x={mix(s.casper.x - 60, 500, s.decrypt)}
            y={mix(s.casper.y - 70, compact ? 115 : 98, s.decrypt)}
          />
        </g>
        <text
          x="500"
          y={compact ? 285 : 247}
          textAnchor="middle"
          className="film-label"
          fontSize={textSize}
        >
          {s.decrypt > 0.5
            ? "SHARED SECRET → PRIVATE CONTENT"
            : "PUBLIC KEY → THE RIGHT RECORD"}
        </text>
      </g>
      <g
        opacity={s.invite}
        transform={`translate(${mix(s.boo.x + 70, s.casper.x - 70, s.inviteTravel)} ${mix(s.boo.y - 70, s.casper.y - 70, s.inviteTravel) - Math.sin(s.inviteTravel * Math.PI) * 95}) rotate(${Math.sin(s.inviteTravel * Math.PI) * -7})`}
      >
        <rect x="-71" y="-44" width="142" height="88" rx="11" fill="#cadbba" />
        <path
          d="m-70-35 70 47 70-47"
          stroke="#607e69"
          strokeWidth="1.5"
          fill="none"
        />
        <circle r="15" fill="#e3e9cf" />
        <g color="#526b54">
          <Key x={-2} y={0} />
        </g>
      </g>
      <g opacity={appear(t, 1.72, 2.04, 0.08)}>
        {[s.boo, s.casper].map((ghost, i) => (
          <g
            key={i}
            transform={`translate(${ghost.x} ${ghost.y - 130})`}
            color="#b8d1af"
          >
            <Key x={-65} y={0} />
            <text x="-39" y="5" className="film-label" fontSize={textSize}>
              SHARED SECRET
            </text>
          </g>
        ))}
      </g>
      <g
        opacity={finale ? 0 : appear(t, 4.46, 5.03)}
        transform={`translate(500 ${compact ? 180 : 148})`}
      >
        <circle r="35" fill="#173a30" stroke="#8ebd9c" strokeOpacity=".4" />
        <g color="#c1e8c6">
          <Lock y={-4} scale={1.5} />
        </g>
        <text
          y="69"
          textAnchor="middle"
          fill="#e2efdf"
          fontSize={compact ? 27 : 21}
        >
          Connection established.
        </text>
        <text
          y="96"
          textAnchor="middle"
          className="film-label"
          fontSize={textSize}
        >
          END-TO-END ENCRYPTED
        </text>
      </g>
      <g opacity={appear(t, 9.2, 10.4)}>
        {records.map((record, i) => (
          <g
            key={i}
            opacity={1 - beat(t, 9.4 + i * 0.1, 9.56 + i * 0.1)}
            transform={`translate(${record.x} ${record.y})`}
          >
            <rect
              x="-36"
              y="-17"
              width="72"
              height="34"
              rx="6"
              fill="#1a2f29"
              stroke="#93b1a1"
              strokeOpacity=".35"
            />
            <g color="#8faf9a">
              <Lock scale={0.7} />
            </g>
          </g>
        ))}
        <g
          transform={`translate(500 ${compact ? 200 : 165})`}
          opacity={beat(t, 9.52, 9.87)}
        >
          <path
            d="M-25-3h50v41h-50zM-18-3v-15h36v15"
            fill="#11241d"
            stroke="#839e8b"
          />
          <path d="M-9 18h18" stroke="#b8d0b4" />
          <text
            y="72"
            textAnchor="middle"
            fill="#d5e0cf"
            fontSize={compact ? 25 : 20}
          >
            Still yours. On your device.
          </text>
        </g>
      </g>
      <Ghost {...s.boo} peer={0} t={t} compact={compact} />
      <Ghost {...s.casper} peer={1} t={t} compact={compact} />
      <g
        opacity={1 - beat(t, 0.68, 1)}
        transform={`translate(${compact ? 650 : 666} ${compact ? 85 : 100})`}
      >
        <rect
          x="-83"
          y="-18"
          width="166"
          height="38"
          rx="19"
          fill="#152722"
          stroke="#9cc2b4"
          strokeOpacity=".22"
        />
        <text textAnchor="middle" y="6" fill="#b9cfc4" fontSize="13">
          Is anybody out there?
        </text>
      </g>
    </svg>
  );
}

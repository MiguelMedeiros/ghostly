import type { CSSProperties, ReactNode } from "react";
import { APPEAR, BACK, DROP, EVER, LIVE, along, at, passes, path, reverse, type P, type Stage } from "./protocolTimeline";

/**
 * The picture of the protocol explainer: the app's pairing scene (two ghosts,
 * the DHT mesh between them, packets on their routes) told in eight steps.
 * Nothing here keeps state; every shape takes its times from protocolTimeline.ts
 * and reads `--t` through the rules in app/dev-steps.css.
 */

export type SceneCopy = {
  boo: string;
  casper: string;
  dht: string;
  dhtShort: string;
  oob: string;
  pinned: string;
  common: string;
  off: string;
  live: string;
  onDht: string;
  onDhtShort: string;
  back: string;
};

/** The ghost of the app's icon (src/components/pairing/PairingScene.tsx), in an 80 × 100 box, with its cut hem. */
const GHOST_PATH = "M40 8 C18 8 8 22 8 40 L8 72 L16 64 L24 72 L32 64 L40 72 L48 64 L56 72 L64 64 L72 72 L72 40 C72 22 62 8 40 8Z";

type Vars = CSSProperties & Record<`--${string}`, string | number>;
/** Timing for the rules in dev-steps.css: a start, an end, fade-in and fade-out lengths, a dim level, a glide. */
function v(o: { a?: number; b?: number; d?: number; f?: number; lv?: number }, extra?: CSSProperties): Vars {
  const out: Vars = { ...extra };
  for (const [k, x] of Object.entries(o)) if (x !== undefined) out[`--${k}`] = x;
  return out;
}

/** Visible from a to b. */
function Win({ a, b, d, f, children }: { a: number; b: number; d?: number; f?: number; children: ReactNode }) {
  return (
    <g className="sx-win" style={v({ a, b, d, f })}>
      {children}
    </g>
  );
}

/** Pops in at a (a small rise in scale about its own centre) and stays. */
function Pop({ a, d = 0.32, children }: { a: number; d?: number; children: ReactNode }) {
  return (
    <g className="sx-go sx-pop" style={v({ a, d })}>
      {children}
    </g>
  );
}

/** A packet: a dot that travels its route from a over d, visible only on the way. */
function Packet({ pts, a, d, r, tone }: { pts: readonly P[]; a: number; d: number; r: number; tone: string }) {
  return (
    <g className="sx-go sx-trip" style={v({ a, d }, { transform: along(pts) })}>
      <circle r={r} className={`sx-pk sx-${tone}`} />
    </g>
  );
}

/** A tag: a mono label on a plate of the stage's own colour, so a faint line behind it never runs through the text. */
function Tag({ x, y, text, tone = "dim", mono = true }: { x: number; y: number; text: string; tone?: string; mono?: boolean }) {
  const w = Math.round(text.length * (mono ? 8.4 : 7.6) + 18);
  return (
    <g className={`sx-tag sx-tag--${tone}`}>
      <rect x={x - w / 2} y={y - 12} width={w} height={24} rx={12} />
      <text x={x} y={y + 5} textAnchor="middle" className={mono ? "mono" : undefined}>
        {text}
      </text>
    </g>
  );
}

type Mood = "calm" | "happy" | "glance";
function Eyes({ mood }: { mood: Mood }) {
  if (mood === "happy")
    return (
      <g className="sx-eyes" fill="none" strokeWidth="4" strokeLinecap="round">
        <path d="M22 38 Q29 30 36 38" />
        <path d="M44 38 Q51 30 58 38" />
      </g>
    );
  const dx = mood === "glance" ? 3 : 0;
  return (
    <g className={`sx-eyes${mood === "calm" ? " psx-blink" : ""}`}>
      <circle cx={29 + dx} cy="36" r="6" />
      <circle cx={51 + dx} cy="36" r="6" />
      <circle className="sx-shine" cx={31 + dx} cy="34" r="2" />
      <circle className="sx-shine" cx={53 + dx} cy="34" r="2" />
    </g>
  );
}

/** The moods of both ghosts over the whole timeline: calm, happy once live, a glance at each other while the line is down. */
const MOODS: { mood: Mood; a: number; b: number }[] = [
  { mood: "calm", a: -EVER, b: LIVE },
  { mood: "happy", a: LIVE, b: DROP },
  { mood: "glance", a: DROP, b: BACK },
  { mood: "happy", a: BACK, b: EVER },
];

function Ghost({ at: [x, y], s, who, flip }: { at: P; s: number; who: "boo" | "casper"; flip?: boolean }) {
  const casper = who === "casper";
  const body = (
    <>
      <circle className="sx-halo" cx="40" cy="40" r="44" />
      <path className="sx-body" d={GHOST_PATH} />
      {MOODS.map((m, i) => (
        <g key={i} className="sx-win" style={v({ a: m.a, b: m.b, d: 0.08, f: 0.08 })} transform={flip ? "translate(80 0) scale(-1 1)" : undefined}>
          <Eyes mood={m.mood} />
        </g>
      ))}
    </>
  );
  return (
    <g className={`sx-ghost sx-ghost--${who}`} transform={`translate(${round1(x - 40 * s)} ${round1(y - 43.6 * s)}) scale(${s})`}>
      <ellipse className="sx-shadow" cx="40" cy="92" rx="22" ry="4" />
      <g className="sx-go sx-hop" style={v({ a: LIVE, d: 0.7 })}>
        <g className="sx-go sx-hop" style={v({ a: BACK, d: 0.7 })}>
          <g className={`psx-float${casper ? " psx-float--late" : ""}`}>
            {casper ? (
              <>
                {/* Casper is only an outline until his app opens the invite, as in the app's scene. */}
                <path className="sx-outline sx-out" style={v({ b: APPEAR + 0.3, f: 0.3 })} d={GHOST_PATH} />
                <g className="sx-in" style={v({ a: APPEAR, d: 0.5 })}>
                  {body}
                </g>
              </>
            ) : (
              body
            )}
          </g>
        </g>
      </g>
    </g>
  );
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

/** A small key: a contact pinned. */
function KeyBadge({ x, y, a, b, text }: { x: number; y: number; a: number; b: number; text: string }) {
  const w = Math.round(text.length * 7.6 + 44);
  return (
    <Win a={a} b={b}>
      <Pop a={a}>
        <g className="sx-tag sx-tag--key">
          <rect x={x - w / 2} y={y - 12} width={w} height={24} rx={12} />
          <g transform={`translate(${x - w / 2 + 16} ${y})`} className="sx-key">
            <circle cx="0" cy="0" r="4.5" />
            <path d="M4.5 0 H13 M10 0 V4 M13 0 V3" />
          </g>
          <text x={x - w / 2 + 34} y={y + 5}>
            {text}
          </text>
        </g>
      </Pop>
    </Win>
  );
}

function Check({ x, y, a, b, tone }: { x: number; y: number; a: number; b: number; tone: string }) {
  return (
    <Win a={a} b={b}>
      <Pop a={a} d={0.25}>
        <circle cx={x} cy={y} r={9} className={`sx-check-bg sx-${tone}`} />
        <path d={`M${x - 4} ${y} l3 3 l5 -6`} className="sx-check" />
      </Pop>
    </Win>
  );
}

/** A frame that travels the live line: a message, a file piece or a payment. */
function Glyph({ kind }: { kind: "message" | "file" | "payment" }) {
  if (kind === "message") return <path className="sx-glyph sx-talk" d="M-7 -7h14a3 3 0 0 1 3 3v6a3 3 0 0 1 -3 3h-6l-5 4v-4h-3a3 3 0 0 1 -3 -3v-6a3 3 0 0 1 3 -3z" />;
  if (kind === "file") return <path className="sx-glyph sx-talk" d="M-6 -8h8l5 5v11h-13z M2 -8v5h5" />;
  return (
    <g>
      <circle r={8} className="sx-glyph sx-pay" />
      <text y={4} textAnchor="middle" className="sx-coin">
        ₿
      </text>
    </g>
  );
}

function Thumbs({ x, y, a, b }: { x: number; y: number; a: number; b: number }) {
  return (
    <Win a={a} b={b}>
      <Pop a={a} d={0.4}>
        <g transform={`translate(${x} ${y})`} className="sx-thumbs">
          <path className="sx-bubble" d="M-22 -18 h44 a8 8 0 0 1 8 8 v20 a8 8 0 0 1 -8 8 h-16 l-8 8 v-8 h-20 a8 8 0 0 1 -8 -8 v-20 a8 8 0 0 1 8 -8z" />
          {/* A thumbs-up, drawn for this scene: a cuff and a hand with its thumb raised. */}
          <g transform="translate(-12 -14)">
            <rect x="1" y="11" width="5" height="12" rx="1.5" className="sx-thumb" />
            <path className="sx-thumb" d="M8 11 L12 3.5 C12.6 2.4 14.6 2.8 14.6 4.4 L14 10 H21 C22.5 10 23.5 11.3 23.2 12.7 L21.6 20.6 C21.4 21.6 20.5 22.2 19.5 22.2 H8 Z" />
          </g>
        </g>
      </Pop>
    </Win>
  );
}

export function StepScene({ g, t, className }: { g: Stage; t: SceneCopy; className: string }) {
  const { nodes, line } = g;
  const [mx, my] = g.me;
  const [px] = g.peer;
  const edge0 = line.x0;
  const edge1 = line.x1;
  const lineD = `M${edge0} ${line.y} L${edge1} ${line.y}`;
  const laneD = (y: number) => `M${edge0} ${y} L${edge1} ${y}`;
  const cx = Math.round((edge0 + edge1) / 2);
  const offset = g.pk + 2;
  const lane = (y: number): P[] => [
    [edge0, y],
    [edge1, y],
  ];

  // Step 1: Boo's two records go up the network.
  const pubA = { a: at(0, 0.35), d: 1.0 };
  const pubB = { a: at(0, 0.55), d: 1.0 };
  const pubAPass = passes(g.pubUp, pubA.a, pubA.d);
  const pubBPass = passes(g.pubLow, pubB.a, pubB.d);
  const gone1 = at(2, 0.25);

  // Step 3: Casper knocks on both layers at once, Boo answers on both.
  const knock = { a: at(2, 0.35), d: 1.3 };
  const inUp = reverse(g.up);
  const inLow = reverse(g.low);
  const inUpPass = passes(inUp, knock.a, knock.d);
  const inLowPass = passes(inLow, knock.a, knock.d);
  const reply = { a: at(2, 1.95), d: 1.2 };
  const gone3 = at(3, 0.2);

  const lit = (id: keyof typeof nodes, a: number, b: number, tone: string) => (
    <circle key={`${id}-${a}`} className={`sx-lit sx-${tone} sx-win`} style={v({ a, b, d: 0.2 })} cx={nodes[id][0]} cy={nodes[id][1]} r={g.pk + 0.5} />
  );

  // Step 4: the offers.
  const chipsMe = ["chat/1", "files/2", "payments/1", "hold/1"];
  const chipsPeer = ["chat/1", "files/2", "payments/1"];
  const match = at(3, 1.3);
  const gone4 = at(4, 0.2);

  // Step 5: two shared transports, ranked. The first is already where the line will run.
  const [yA, yB] = g.lanes;
  const rank = at(4, 1.4);

  // Step 7: the frames of a live chat.
  const chunks = [0, 0.15, 0.3].map((k) => round3(at(6, 1.85) + k));

  return (
    <svg viewBox={`0 0 ${g.w} ${g.h}`} className={`stage psx-svg ${className}`} aria-hidden="true" focusable="false">
      <defs>
        {["boo", "casper", "talk"].map((tone) => (
          <marker key={tone} id={`sx-arrow-${tone}-${className}`} className={`sx-arrow sx-${tone}`} viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0 0 L8 4 L0 8 Z" />
          </marker>
        ))}
      </defs>

      {/* Layer 0: the DHT. It recedes while the live line carries the chat, and comes back when the line drops. */}
      <g className="sx-dim" style={v({ a: at(3, 0), b: DROP, d: 0.4, f: 0.4, lv: 0.32 })}>
        <g className="sx-dim" style={v({ a: BACK, b: EVER, d: 0.4, lv: 0.32 })}>
          <text className="sx-label" x={g.label[0]} y={g.label[1] + 5} textAnchor="middle">
            {g.short ? t.dhtShort : t.dht}
          </text>
          {g.mesh.map((pts, i) => (
            <path key={i} className="sx-mesh" d={path(pts)} />
          ))}
          <path className="sx-edge" d={path(g.up)} />
          <path className="sx-edge" d={path(g.low)} />
          {g.dots.map(([x, y]) => (
            <circle key={`${x}-${y}`} className="sx-dot" cx={x} cy={y} r={2} />
          ))}
          {Object.entries(nodes).map(([id, [x, y]]) => (
            <circle key={id} className="sx-node" cx={x} cy={y} r={g.pk} />
          ))}
          {/* Nodes that hold Boo's records, then the ones Casper's knock passes. */}
          {lit("n1", pubAPass[1], gone1, "boo")}
          {lit("n3", pubAPass[2], gone1, "boo")}
          {lit("n2", pubBPass[1], gone1, "boo")}
          {lit("n6", pubBPass[2], gone1, "boo")}
          {lit("n4", inUpPass[1], gone3, "casper")}
          {lit("n3", inUpPass[2], gone3, "casper")}
          {lit("n1", inUpPass[3], gone3, "casper")}
          {lit("n5", inLowPass[1], gone3, "casper")}
          {lit("n6", inLowPass[2], gone3, "casper")}
          {lit("n2", inLowPass[3], gone3, "casper")}
        </g>
      </g>

      {/* The way each step's packets went, drawn with arrowheads: what a still frame needs. */}
      <Win a={at(0, 0.4)} b={gone1}>
        <path className="sx-route sx-boo" d={path(g.pubUp)} markerEnd={`url(#sx-arrow-boo-${className})`} />
        <path className="sx-route sx-boo" d={path(g.pubLow)} markerEnd={`url(#sx-arrow-boo-${className})`} />
      </Win>
      <Win a={at(2, 0.5)} b={gone3}>
        <path className="sx-route sx-casper" d={path(inUp)} markerEnd={`url(#sx-arrow-casper-${className})`} />
        <path className="sx-route sx-casper" d={path(inLow)} markerEnd={`url(#sx-arrow-casper-${className})`} />
      </Win>
      <Win a={at(7, 1.0)} b={EVER}>
        <path className="sx-route sx-talk" d={path(g.up)} markerEnd={`url(#sx-arrow-talk-${className})`} />
      </Win>

      {/* Step 1: the two records, resting where the network keeps them. */}
      {(
        [
          [nodes.n3, pubAPass[2]],
          [nodes.n6, pubBPass[2]],
        ] as const
      ).map(([[x, y], a]) => (
        <Win key={`${x}-${y}`} a={a} b={gone1}>
          <Pop a={a}>
            <g transform={`translate(${x} ${y})`} className="sx-record">
              <rect x={-8} y={-10} width={16} height={20} rx={3} />
              <path d="M-4 -4 H4 M-4 0 H4 M-4 4 H2" />
            </g>
          </Pop>
        </Win>
      ))}
      {/* The records stay for step 2; their names make room for the invite's. */}
      <Win a={at(0, 0.45)} b={at(1, 0.2)} f={0.15}>
        <Tag x={g.tagTop[0]} y={g.tagTop[1]} text="_caps" tone="boo" />
      </Win>
      <Win a={at(0, 0.65)} b={at(1, 0.2)} f={0.15}>
        <Tag x={g.tagLow[0]} y={g.tagLow[1]} text="presence" tone="boo" />
      </Win>
      <Packet pts={g.pubUp} {...pubA} r={g.pk} tone="boo" />
      <Packet pts={g.pubLow} {...pubB} r={g.pk} tone="boo" />

      {/* Step 2: the invite goes out of band, by link or QR. */}
      <Win a={at(1, 0.15)} b={gone1}>
        <path className="sx-oob sx-go sx-draw" style={v({ a: at(1, 0.15), d: 0.5 })} d={g.oob.d} pathLength={1} />
        <text className="sx-oob-tag" x={g.oob.tag[0]} y={g.oob.tag[1] + 5} textAnchor="middle">
          {t.oob}
        </text>
      </Win>
      <Win a={at(1, 0.5)} b={gone1}>
        <Tag x={g.oob.code[0]} y={g.oob.code[1]} text="ghostly1p…" tone="boo" />
      </Win>
      <Win a={at(1, 0.35)} b={APPEAR + 0.35}>
        <g className="sx-go sx-land" style={v({ a: at(1, 0.35), d: 1.4 }, { transform: along(g.oob.pts) })}>
          <g className="sx-ticket">
            <rect x={-9} y={-7} width={18} height={14} rx={2.5} />
            <path d="M-8 -6 L0 1 L8 -6" />
          </g>
        </g>
      </Win>

      {/* Step 3: the knock on both layers, the pin, the answer on both. */}
      <Win a={at(2, 0.35)} b={gone3}>
        <Tag x={g.tagTop[0]} y={g.tagTop[1]} text={g.short ? "_dm" : "_dm envelope"} tone="casper" />
        <Tag x={g.tagLow[0]} y={g.tagLow[1]} text={g.short ? "_rtc" : "_rtc offer"} tone="casper" />
      </Win>
      <Packet pts={inUp} {...knock} r={g.pk} tone="casper" />
      <Packet pts={inLow} {...knock} r={g.pk} tone="casper" />
      <circle className="sx-go sx-burst sx-ring sx-casper" style={v({ a: at(2, 1.65), d: 0.8 })} cx={mx} cy={my} r={32 * g.s} />
      <KeyBadge x={mx} y={g.keyY} a={at(2, 1.8)} b={gone3} text={t.pinned} />
      <Packet pts={g.up} {...reply} r={g.pk} tone="boo" />
      <Packet pts={g.low} {...reply} r={g.pk} tone="boo" />
      <KeyBadge x={px} y={g.keyY} a={at(2, 3.2)} b={gone3} text={t.pinned} />

      {/* Step 4: each side's offer, what both list lights up; the rest stays off. */}
      {(
        [
          [g.chips.me, chipsMe, at(3, 0.35), "boo"],
          [g.chips.peer, chipsPeer, at(3, 0.55), "casper"],
        ] as const
      ).map(([x, list, a0, who]) =>
        list.map((id, k) => {
          const y = g.chips.ys[k];
          const shared = chipsMe.includes(id) && chipsPeer.includes(id);
          const w = g.chips.w;
          return (
            <Win key={`${who}-${id}`} a={round3(a0 + k * 0.06)} b={gone4} d={0.25}>
              <Pop a={round3(a0 + k * 0.06)} d={0.28}>
                <g className={shared ? "sx-chip" : "sx-chip sx-dim"} style={shared ? undefined : v({ a: match, b: EVER, lv: 0.4 })}>
                  <rect x={x - w / 2} y={y} width={w} height={g.chips.h} rx={g.chips.h / 2} />
                  {shared && <rect className={`sx-chip-lit sx-${who} sx-in`} style={v({ a: match, d: 0.3 })} x={x - w / 2} y={y} width={w} height={g.chips.h} rx={g.chips.h / 2} />}
                  <text className="mono" x={x} y={y + g.chips.h / 2 + 5} textAnchor="middle">
                    {id}
                  </text>
                </g>
              </Pop>
            </Win>
          );
        }),
      )}
      <Win a={at(3, 1.7)} b={gone4}>
        <Pop a={at(3, 1.7)}>
          <Tag x={cx} y={line.y} text={t.common} tone="line" mono={false} />
        </Pop>
      </Win>

      {/* Step 5: the shared transports and their sums; the relayed one steps back behind the direct one. */}
      <Win a={at(4, 0.35)} b={at(5, 0.15)} d={0.3} f={0.15}>
        <path className="sx-lane" d={laneD(yA)} />
        <Tag x={cx} y={yA} text={g.short ? "webrtc/1 · 4" : "webrtc/1 · 3 + 1 = 4 · direct"} tone="line" />
      </Win>
      <Win a={at(4, 0.6)} b={at(5, 0.2)} d={0.3} f={0.15}>
        <g className="sx-dim" style={v({ a: rank, b: EVER, d: 0.4, lv: 0.4 })}>
          <path className="sx-lane" d={laneD(yB)} />
          <Tag x={cx} y={yB} text={g.short ? "iroh/1 · 3 · relayed" : "iroh/1 · 1 + 2 = 3 · relayed"} tone="dim" />
        </g>
      </Win>

      {/* The live line: connecting (dashed), live (solid), dropped (broken), back. */}
      <Win a={at(5, 0)} b={LIVE + 0.1} d={0.15}>
        <path className="sx-line sx-line--dash psx-dash" d={lineD} />
      </Win>
      <Win a={at(7, 2.5)} b={BACK + 0.1} d={0.3}>
        <path className="sx-line sx-line--dash psx-dash" d={lineD} />
      </Win>
      {(
        [
          [LIVE, DROP],
          [BACK, EVER],
        ] as const
      ).map(([a, b]) => (
        <Win key={a} a={a} b={b} d={0.3}>
          <path className="sx-glow" d={lineD} />
          <path className="sx-line" d={lineD} />
        </Win>
      ))}
      <Win a={DROP} b={at(7, 2.5)} d={0.25} f={0.3}>
        <path className="sx-broken" d={`M${edge0} ${line.y} L${cx - 14} ${line.y} M${cx + 14} ${line.y} L${edge1} ${line.y}`} />
        <path className="sx-cross" d={`M${cx - 7} ${line.y - 7} L${cx + 7} ${line.y + 7} M${cx + 7} ${line.y - 7} L${cx - 7} ${line.y + 7}`} />
      </Win>

      {/* Under the line: which transport, and in what state. */}
      <Win a={at(5, 0.3)} b={LIVE}>
        <Tag x={cx} y={g.below} text="webrtc/1" tone="line" />
      </Win>
      <Win a={LIVE} b={DROP}>
        <Tag x={cx} y={g.below} text={g.short ? t.live : `webrtc/1 · ${t.live}`} tone="line" mono={!g.short} />
      </Win>
      <Win a={DROP} b={BACK}>
        <Tag x={cx} y={g.below} text={g.short ? t.onDhtShort : t.onDht} tone="danger" mono={false} />
      </Win>
      <Win a={BACK} b={EVER}>
        <Tag x={cx} y={g.below} text={g.short ? t.back : `webrtc/1 · ${t.back}`} tone="line" mono={!g.short} />
      </Win>

      {/* Above the line: the frame on its way. */}
      {(
        [
          ["pair-proof", at(5, 0.3), at(5, 2.0)],
          ["pair-ready", at(5, 2.0), LIVE + 0.3],
          ["paired-message", at(6, 0.3), at(6, 1.75)],
          [g.short ? "pf-data" : "files/3 · pf-data", at(6, 1.75), at(6, 3.0)],
          [g.short ? "pay" : "pay · 2,100 sat", at(6, 3.0), at(6, 3.9)],
        ] as const
      ).map(([text, a, b]) => (
        <Win key={text} a={a} b={b} d={0.2} f={0.14}>
          <Tag x={cx} y={g.above} text={text} tone="talk" />
        </Win>
      ))}

      {/* Step 6: each side's proof, one after the other, then both ready. */}
      <Packet pts={lane(line.y - offset)} a={at(5, 0.35)} d={0.8} r={g.pk} tone="boo" />
      <Check x={px - 34 * g.s - 14} y={line.y - 22} a={at(5, 1.15)} b={LIVE} tone="boo" />
      <Packet pts={reverse(lane(line.y + offset))} a={at(5, 1.2)} d={0.8} r={g.pk} tone="casper" />
      <Check x={mx + 34 * g.s + 14} y={line.y - 22} a={at(5, 2.0)} b={LIVE} tone="casper" />
      <Packet pts={lane(line.y - offset)} a={at(5, 2.0)} d={0.55} r={g.pk} tone="boo" />
      <Packet pts={reverse(lane(line.y + offset))} a={at(5, 2.0)} d={0.55} r={g.pk} tone="casper" />

      {/* Step 7: a message and its receipt, a file in pieces, a payment. */}
      <g className="sx-go sx-trip" style={v({ a: at(6, 0.35), d: 0.9 }, { transform: along(lane(line.y)) })}>
        <Glyph kind="message" />
      </g>
      <Packet pts={reverse(lane(line.y))} a={at(6, 1.3)} d={0.45} r={g.pk - 1.5} tone="casper" />
      {chunks.map((a) => (
        <g key={a} className="sx-go sx-trip" style={v({ a, d: 0.8 }, { transform: along(reverse(lane(line.y))) })}>
          <rect x={-5} y={-5} width={10} height={10} rx={2} className="sx-glyph sx-talk" />
        </g>
      ))}
      <Check x={mx + 34 * g.s + 14} y={line.y - 22} a={at(6, 2.95)} b={at(6, 3.4)} tone="casper" />
      <g className="sx-go sx-trip" style={v({ a: at(6, 3.05), d: 0.8 }, { transform: along(lane(line.y)) })}>
        <Glyph kind="payment" />
      </g>
      <Win a={at(6, 3.9)} b={at(7, 0.25)} d={0.25} f={0.15}>
        {(["message", "file", "payment"] as const).map((k, i) => (
          <Pop key={k} a={round3(at(6, 3.9) + i * 0.06)} d={0.28}>
            <g transform={`translate(${cx + (i - 1) * g.trio} ${line.y})`}>
              <circle r={g.pk * 3} className="sx-trio" />
              <Glyph kind={k} />
            </g>
          </Pop>
        ))}
      </Win>

      {/* Step 8: short text over the DHT while the line is down. */}
      <Win a={at(7, 0.9)} b={EVER}>
        <Tag x={g.tagTop[0]} y={g.tagTop[1]} text={g.short ? "_dm · 256 B" : "_dm · text up to 256 B"} tone="talk" />
      </Win>
      <g className="sx-go sx-trip" style={v({ a: at(7, 1.0), d: 1.3 }, { transform: along(g.up) })}>
        <circle r={g.pk} className="sx-pk sx-talk" />
      </g>

      {/* The live moment, twice: rings from both ghosts and the middle of the line. */}
      {[LIVE, BACK].map((a) => (
        <g key={a}>
          <circle className="sx-go sx-burst sx-ring sx-boo" style={v({ a, d: 0.8 })} cx={mx} cy={my} r={34 * g.s} />
          <circle className="sx-go sx-burst sx-ring sx-casper" style={v({ a, d: 0.8 })} cx={px} cy={my} r={34 * g.s} />
          <circle className="sx-go sx-burst sx-ring sx-line-tone" style={v({ a: round3(a + 0.15), d: 0.8 })} cx={cx} cy={line.y} r={12} />
        </g>
      ))}

      <Ghost at={g.me} s={g.s} who="boo" />
      <Ghost at={g.peer} s={g.s} who="casper" flip />
      <text className="sx-name" x={mx} y={g.nameY} textAnchor="middle">
        {t.boo}
      </text>
      <text className="sx-name" x={px} y={g.nameY} textAnchor="middle">
        {t.casper}
      </text>
      <Thumbs x={g.thumbs[0]} y={g.thumbs[1]} a={round3(LIVE + 0.35)} b={at(6, 0.25)} />
    </svg>
  );
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

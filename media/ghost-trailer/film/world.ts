// The crowd the story crosses: a field of nodes joined by a dotted mesh (the Mainline DHT, drawn the way the site
// and the app's pairing scene draw it), the strangers that live in it, and the routes the notes travel. Everything
// comes from a seeded generator, so every worker builds the same world.

export type P = { x: number; y: number };
export type Node = P & { id: number; d: number; outer: boolean; stranger: boolean };

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Boo on the left, Casper on the right. */
export const BOO: P = { x: -640, y: 40 };
export const CASPER: P = { x: 640, y: 40 };

const random = seeded(20260926);
const nodes: Node[] = [];
// The inner crowd, between the two of them, kept a little apart from each other.
for (let tries = 0; nodes.length < 150 && tries < 20000; tries++) {
  const x = (random() * 2 - 1) * 560, y = (random() * 2 - 1) * 360;
  if ((x / 560) ** 2 + (y / 360) ** 2 > 1) continue;
  if (nodes.some((n) => Math.hypot(n.x - x, n.y - y) < 62)) continue;
  nodes.push({ id: nodes.length, x, y, d: Math.hypot(x, y * 1.4), outer: false, stranger: false });
}
// Millions of strangers: the field goes on far past the frame.
for (let tries = 0; nodes.length < 1150 && tries < 60000; tries++) {
  const angle = random() * Math.PI * 2, r = 0.3 + random() * 0.95;
  const x = Math.cos(angle) * r * 3000, y = Math.sin(angle) * r * 1800;
  if ((x / 600) ** 2 + (y / 390) ** 2 < 1) continue;
  if (nodes.some((n) => Math.abs(n.x - x) < 70 && Math.hypot(n.x - x, n.y - y) < 70)) continue;
  nodes.push({ id: nodes.length, x, y, d: Math.hypot(x, y * 1.4), outer: true, stranger: false });
}
nodes.forEach((n) => { n.stranger = random() < (n.outer ? 0.2 : 0.3); });
export const NODES = nodes;

/** Each node joined to its nearest neighbours (dotted), once per pair. */
export const EDGES: [number, number][] = [];
const seen = new Set<string>();
for (const n of nodes) {
  const near = nodes.filter((m) => m !== n && Math.abs(m.x - n.x) < 260).map((m) => [m, Math.hypot(m.x - n.x, m.y - n.y)] as const).sort((a, b) => a[1] - b[1]).slice(0, n.outer ? 2 : 3);
  for (const [m, dist] of near) {
    if (dist > (n.outer ? 260 : 190)) continue;
    const key = n.id < m.id ? `${n.id}-${m.id}` : `${m.id}-${n.id}`;
    if (!seen.has(key)) { seen.add(key); EDGES.push([n.id, m.id]); }
  }
}
export const NEIGHBOURS: number[][] = nodes.map(() => []);
for (const [a, b] of EDGES) { NEIGHBOURS[a].push(b); NEIGHBOURS[b].push(a); }

const nearest = (p: P, pool = nodes.filter((n) => !n.outer)) => pool.reduce((best, n) => (Math.hypot(n.x - p.x, n.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y) ? n : best));
/** A route from `from` to the node nearest `to`: the inner nodes nearest evenly spaced points on the way. */
function route(from: P, to: P, hops: number): P[] {
  const path: P[] = [from];
  for (let k = 1; k <= hops; k++) {
    const p = { x: from.x + ((to.x - from.x) * k) / hops, y: from.y + ((to.y - from.y) * k) / hops + Math.sin(k * 1.7) * 40 * (k < hops ? 1 : 0) };
    const n = nearest(p);
    if (!path.some((q) => q === n)) path.push(n);
  }
  return path;
}

/** Where Boo's sealed note rests, and where Casper's reply rests. */
export const NOTE_AT: P = nearest({ x: -90, y: -150 });
export const REPLY_AT: P = nearest({ x: 150, y: 170 });
/** Boo → the note's node; Casper → the note's node; Casper → the reply's node → Boo. */
export const ROUTE_NOTE = route({ x: BOO.x + 70, y: BOO.y - 20 }, NOTE_AT, 4);
export const ROUTE_LOOK = route({ x: CASPER.x - 70, y: CASPER.y - 20 }, NOTE_AT, 5);
export const ROUTE_REPLY = [...route({ x: CASPER.x - 70, y: CASPER.y + 10 }, REPLY_AT, 3), ...route(REPLY_AT, { x: BOO.x + 70, y: BOO.y + 10 }, 4).slice(1)];

/** The strangers nearest the note: they come to look, and see nothing. */
export const PEEKERS = nodes.filter((n) => n.stranger && !n.outer && n !== NOTE_AT).sort((a, b) => Math.hypot(a.x - NOTE_AT.x, a.y - NOTE_AT.y) - Math.hypot(b.x - NOTE_AT.x, b.y - NOTE_AT.y)).slice(0, 3);

/** A point `p` (0…1) of the way along a polyline, evenly by length. */
export function along(path: P[], p: number): P {
  const lengths = path.slice(1).map((q, i) => Math.hypot(q.x - path[i].x, q.y - path[i].y));
  let left = Math.min(1, Math.max(0, p)) * lengths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] || i === lengths.length - 1) {
      const f = lengths[i] ? Math.min(1, left / lengths[i]) : 1;
      return { x: path[i].x + (path[i + 1].x - path[i].x) * f, y: path[i].y + (path[i + 1].y - path[i].y) * f };
    }
    left -= lengths[i];
  }
  return path.at(-1)!;
}

/** The strangers' own traffic: little packets walking the mesh, each on its own seeded walk. */
export function packet(k: number, t: number, from: number, hop = 0.55): { a: P; b: P; f: number } | null {
  if (t < from) return null;
  const walk = seeded(1000 + k);
  const inner = nodes.filter((n) => !n.outer);
  let at = inner[Math.floor(walk() * inner.length)].id;
  const steps = Math.floor((t - from) / hop);
  for (let s = 0; s < steps; s++) { const next = NEIGHBOURS[at]; at = next.length ? next[Math.floor(walk() * next.length)] : at; }
  const next = NEIGHBOURS[at];
  const to = next.length ? next[Math.floor(walk() * next.length)] : at;
  return { a: nodes[at], b: nodes[to], f: ((t - from) % hop) / hop };
}

export { seeded };

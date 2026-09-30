import tracks from "./roadmap-tracks.json";
import { TRACKS, type Phase } from "@/content/roadmap-timeline";
import type { Level } from "./status";

/**
 * The roadmap's tracks as the page shows them: the lines of
 * docs/wisps/ADAPTER-ROADMAP.md ("Tracks"), with each track's anchor, colour
 * and short name. A track the site has no presentation for fails the build.
 */
type Item = { text: string; level: Level };
export type Track = {
  id: string;
  n: string;
  title: string;
  why: string;
  now: Item[];
  next: Item[];
  gate: string;
  /** Anchors of the tracks it builds on. */
  after: string[];
  color: string;
  lane: string;
};

const shown = (n: string) => {
  const found = TRACKS[n];
  if (!found) throw new Error(`Track ${n} of ADAPTER-ROADMAP.md has no entry in TRACKS (content/roadmap-timeline.ts)`);
  return found;
};

export const roadmapTracks: Track[] = (tracks as (Omit<Track, "id" | "color" | "lane">)[]).map((t) => ({
  ...t,
  ...shown(t.n),
  after: t.after.map((n) => shown(n).id),
}));

/** Where a line sits on the timeline: what exists is today, research is the horizon, and so is a track with nothing built yet. */
export function phaseItems(track: Track): Partial<Record<Phase, Item[]>> {
  if (!track.now.length) return { later: track.next };
  return {
    now: track.now,
    planned: track.next.filter((i) => i.level === "planned"),
    later: track.next.filter((i) => i.level === "research"),
  };
}

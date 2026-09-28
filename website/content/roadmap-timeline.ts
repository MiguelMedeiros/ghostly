import type { Level } from "@/lib/status";

/**
 * The roadmap as a timeline: columns in the order things happen, one row per
 * track. No dates: a column is a stage, not a quarter. The labels and each
 * track's anchor, colour and short name are here; what a track holds comes
 * from docs/wisps/ADAPTER-ROADMAP.md (lib/roadmap-tracks.json).
 */
export const PHASES = ["now", "planned", "later"] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_LEVEL: Record<Phase, Level> = {
  now: "available",
  planned: "planned",
  later: "planned",
};

type Timeline = {
  mapTitle: string;
  mapLead: string;
  timelineTitle: string;
  timelineLead: string;
  detailsTitle: string;
  grid: {
    presets: string;
    selectHint: string;
    enables: string;
    specs: string;
    noSpec: string;
    docs: string;
    included: string;
    close: string;
    stages: { title: string; play: string; pause: string; names: Record<Level, string> };
  };
  phases: Record<Phase, { title: string; sub: string }>;
  here: string;
  empty: string;
};

export const timeline: Timeline = {
  mapTitle: "The map",
  mapLead: "Every piece of Ghostly, by area. Start from today, then move along the stages to see what comes next. Research is what we are considering, not a plan.",
  timelineTitle: "Stage by stage",
  timelineLead: "Left to right is the order things happen. No dates: a column is a stage, not a quarter.",
  detailsTitle: "Why this order? Dependencies and what \"done\" means",
  grid: {
    presets: "Stages",
    selectHint: "Tap any block to see what it lets you do and where it is specified.",
    enables: "What it enables",
    specs: "Specified in",
    noSpec: "No WISP yet",
    docs: "Reference",
    included: "{n} of {t} pieces",
    close: "Close",
    stages: {
      title: "Stages",
      play: "Play the evolution",
      pause: "Pause",
      names: { available: "Today", planned: "Planned", research: "Research" },
    },
  },
  phases: {
    now: { title: "Today", sub: "What the app does now" },
    planned: { title: "Next steps", sub: "In order of what they depend on" },
    later: { title: "Horizon", sub: "Long-term vision and open questions" },
  },
  here: "We are here",
  empty: "None",
};

/** How a track is shown, by its number in the roadmap document: its anchor, its colour and its row's short name. */
export const TRACKS: Record<string, { id: string; color: string; lane: string }> = {
  "01": { id: "talk", color: "#22d3ee", lane: "Chat" },
  "02": { id: "pay", color: "#fbbf24", lane: "Payments" },
  "03": { id: "reach", color: "#60a5fa", lane: "Connection" },
  "04": { id: "keep", color: "#4ade80", lane: "Profiles & backup" },
  "05": { id: "identity", color: "#f472b6", lane: "Identity (optional)" },
  "06": { id: "groups", color: "#fb923c", lane: "Groups" },
  "07": { id: "sdk", color: "#a78bfa", lane: "SDKs & plugins" },
  "08": { id: "apps", color: "#94a3b8", lane: "Apps & catalogs" },
  "09": { id: "os", color: "#2dd4bf", lane: "Self-hosting" },
};

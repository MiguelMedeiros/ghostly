import numbering from "./wisp-numbering.json";
import index from "./reference-index.json";
import { editorial, GROUPS, type GroupId } from "./wisp-editorial";
import type { Level } from "./status";
import type { Localized } from "./i18n";

/**
 * The WISP catalogue, derived from `docs/wisps/numbering.json` (which drafts
 * exist and their numbers) and the documents themselves (status, dependencies,
 * implementation line), synced by `npm run sync:references`. Editorial copy
 * adds a plain-language benefit and a verified availability; a draft that has
 * none yet still appears, described by its own header.
 */
export type Wisp = {
  id: string;
  /** What to print: "401", or "3xx" while a number is not assigned. */
  number: string;
  assigned: boolean;
  kind: string;
  file: string;
  slug: string;
  aliases: string[];
  /** Title without the "WISP nn:" prefix. */
  name: string;
  fullTitle: string;
  group: GroupId;
  /** The contract this adapter or profile implements, if any. */
  parent?: string;
  status: string;
  updated?: string;
  implementation?: string;
  summary?: string;
  notices: string[];
  dependencies: string[];
  benefit?: Localized<string>;
  level: Level | null;
  note?: Localized<string>;
  feature?: Localized<{ label: string; href: string }>;
  video?: { src: string; poster?: string; chapters?: { at: number; title: string }[] };
};

type IndexEntry = (typeof index)[number] & {
  status?: string;
  updated?: string;
  implementation?: string;
  summary?: string;
  documentKind?: string;
};

function groupFor(id: string): GroupId {
  const n = Number(id);
  const byRange = GROUPS.find((g) => g.ranges.some(([lo, hi]) => n >= lo && n <= hi));
  return byRange?.id ?? "meet";
}

const refs = index as IndexEntry[];

const all: Wisp[] = numbering.map((entry) => {
  const ref = refs.find((r) => r.file === entry.file);
  const slug = entry.file.replace(/\.md$/, "").toLowerCase();
  const fullTitle = ref?.title ?? entry.file;
  const name = fullTitle.replace(/^WISP\s+[^\s:]+(?::|\s+[\u2014-])\s+/, "");
  const extra = editorial[slug];
  return {
    id: entry.id,
    number: entry.displayNumber,
    assigned: entry.numberAssignment !== "unassigned",
    kind: ref?.documentKind && ref.documentKind !== entry.kind ? entry.kind : entry.kind,
    file: entry.file,
    slug,
    aliases: ref?.aliases ?? [],
    name,
    fullTitle,
    group: extra?.group ?? groupFor(entry.id),
    status: ref?.status ?? "Draft",
    updated: ref?.updated,
    implementation: ref?.implementation,
    summary: ref?.summary,
    notices: ref?.notices ?? [],
    dependencies: ref?.dependencies ?? [],
    benefit: extra?.benefit,
    level: extra ? extra.level : null,
    note: extra?.note,
    feature: extra?.feature,
    video: extra?.video,
  };
});

// A family's contract is its round number (100, 200 …); adapters and profiles hang under it.
for (const w of all) {
  const n = Number(w.id);
  if (w.kind === "Contract" || w.kind === "Process" || n < 100) continue;
  const base = String(Math.floor(n / 100) * 100);
  if (all.some((c) => c.id === base)) w.parent = base;
}

/** Narrative order: groups as the story tells them, then by number. */
export const wisps: Wisp[] = [...all].sort((a, b) => {
  const ga = GROUPS.findIndex((g) => g.id === a.group);
  const gb = GROUPS.findIndex((g) => g.id === b.group);
  if (ga !== gb) return ga - gb;
  const oa = GROUPS[ga].order?.indexOf(a.id) ?? -1;
  const ob = GROUPS[gb].order?.indexOf(b.id) ?? -1;
  if (oa !== ob) return (oa < 0 ? 99 : oa) - (ob < 0 ? 99 : ob);
  return Number(a.id) - Number(b.id);
});

export const wispCount = wisps.length;

export function findWisp(slugOrAlias: string): Wisp | undefined {
  return wisps.find((w) => w.slug === slugOrAlias || w.aliases.includes(slugOrAlias));
}

export function wispByFile(file: string): Wisp | undefined {
  return wisps.find((w) => w.file === file);
}

export const wispPath = (w: Pick<Wisp, "slug">) => `/developers/wisps/${w.slug}`;

export { GROUPS };

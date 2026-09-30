// The roadmap's tracks, read from "### Tracks" in docs/wisps/ADAPTER-ROADMAP.md: the site's roadmap
// page and its timeline show these lines and hold no copy of them.
const STATES = { Available: "available", Planned: "planned", Research: "research" };
export function roadmapTracks(markdown) {
  const start = markdown.indexOf("\n### Tracks\n");
  if (start < 0) throw new Error('ADAPTER-ROADMAP.md: the "### Tracks" section is missing');
  const rest = markdown.slice(start + 1).split("\n").slice(1);
  const end = rest.findIndex((line) => /^#{1,3} /.test(line));
  const tracks = [];
  let track;
  for (const line of (end < 0 ? rest : rest.slice(0, end)).map((l) => l.trim())) {
    const heading = line.match(/^#### (\d{2}) (.+)$/);
    if (heading) {
      track = { n: heading[1], title: heading[2], why: "", items: [], gate: "", after: [] };
      tracks.push(track);
      continue;
    }
    if (!track || !line) continue;
    const fail = (message) => {
      throw new Error(`ADAPTER-ROADMAP.md, track ${track.n}: ${message}`);
    };
    const item = line.match(/^- \*\*([^*]+)\*\*: (.+)$/);
    if (line.startsWith("- ")) {
      if (!item || !(item[1] in STATES)) fail(`an item starts with one status in bold (${Object.keys(STATES).join(", ")}): "${line}"`);
      if (/[*`[\]]/.test(item[2])) fail(`an item is plain text: "${item[2]}"`);
      track.items.push({ text: item[2], level: STATES[item[1]] });
    } else if (line.startsWith("Gate: ")) track.gate = line.slice(6);
    else if (line.startsWith("Builds on: ")) track.after = line.slice(11).split(",").map((n) => n.trim());
    else if (!track.why && !track.items.length) track.why = line;
    else fail(`a line that is not an item, "Gate:" or "Builds on:": "${line}"`);
  }
  if (!tracks.length) throw new Error("ADAPTER-ROADMAP.md: no track under ### Tracks");
  for (const t of tracks) {
    if (!t.why || !t.gate || !t.items.length) throw new Error(`ADAPTER-ROADMAP.md, track ${t.n}: needs a paragraph, at least one item and a "Gate:" line`);
    if (tracks.filter((x) => x.n === t.n).length > 1) throw new Error(`ADAPTER-ROADMAP.md: two tracks numbered ${t.n}`);
    for (const n of t.after) if (!tracks.some((x) => x.n === n)) throw new Error(`ADAPTER-ROADMAP.md, track ${t.n}: builds on ${n}, which is not a track`);
  }
  return tracks.map(({ items, ...t }) => ({
    ...t,
    now: items.filter((i) => i.level === "available"),
    next: items.filter((i) => i.level !== "available"),
  }));
}

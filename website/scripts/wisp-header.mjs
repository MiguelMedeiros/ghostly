// What a WISP says about itself for the site, read from its header table (docs/wisps/00-process.md,
// "Header fields the site reads"). The site holds no text per WISP: a draft without these rows fails
// the sync, and so the build.
const LEVELS = { Available: "available", Planned: "planned", Research: "research", "Not applicable": null };
const SITE = "https://ghostly.tools";

/** The header table: the first run of table rows in the document, as [field, value] pairs. */
export function headerRows(body) {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.startsWith("|"));
  if (start < 0) return [];
  const rows = [];
  for (let i = start; i < lines.length && lines[i].startsWith("|"); i++) {
    const row = lines[i].match(/^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/);
    if (row && !/^:?-+:?$/.test(row[1])) rows.push([row[1], row[2]]);
  }
  return rows.slice(1);
}

export function siteFields(body, file) {
  const rows = headerRows(body);
  const fail = (message) => {
    throw new Error(`docs/wisps/${file}: ${message} (see docs/wisps/00-process.md, "Header fields the site reads")`);
  };
  const field = (name) => {
    const found = rows.filter(([key]) => key === name);
    if (found.length > 1) fail(`the header has ${found.length} "${name}" rows`);
    return found[0]?.[1].replace(/\\\|/g, "|");
  };
  const benefit = field("Summary");
  if (!benefit) fail('the header needs a "Summary" row: one line on what it gives a person');
  const availability = field("Availability");
  if (!availability || !(availability in LEVELS)) fail(`the header needs an "Availability" row, one of: ${Object.keys(LEVELS).join(", ")}`);
  const note = field("Notes");
  if (note === "") fail('an empty "Notes" row: write the caveat or remove the row');
  for (const [name, text] of [["Summary", benefit], ["Notes", note ?? ""]])
    if (/[*`[\]]/.test(text) || /(^|\s)_|_(\s|$)/.test(text)) fail(`"${name}" is plain text: no Markdown, no links`);
  const link = field("Feature");
  let feature;
  if (link !== undefined) {
    const parts = link.match(/^\[([^\]]+)\]\((.+)\)$/);
    if (!parts || !parts[2].startsWith(`${SITE}/`)) fail(`"Feature" is one link to a page of ${SITE}, as [label](${SITE}/#anchor)`);
    feature = { label: parts[1], href: parts[2].slice(SITE.length) };
  }
  // A lesson video served by the site; its poster is the same path, as .jpg.
  const watch = field("Video");
  let video;
  if (watch !== undefined) {
    const parts = watch.match(/^\[[^\]]+\]\((.+\.(?:mp4|webm))\)$/);
    if (!parts || !parts[1].startsWith(`${SITE}/`)) fail(`"Video" is one link to a video file on ${SITE}, as [Watch](${SITE}/videos/name.mp4)`);
    const src = parts[1].slice(SITE.length);
    video = { src, poster: src.replace(/\.\w+$/, ".jpg") };
  }
  return { benefit, level: LEVELS[availability], ...(note ? { note } : {}), ...(feature ? { feature } : {}), ...(video ? { video } : {}) };
}

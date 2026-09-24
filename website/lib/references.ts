import numbering from "./wisp-numbering.json";
import index from "./reference-index.json";

export type Reference = {
  file: string;
  sourcePath: string;
  aliases: string[];
  slug: string;
  title: string;
  dependencies: string[];
  notices: string[];
  status?: string;
  updated?: string;
  implementation?: string;
  summary?: string;
};

/** Every synced document the reader can show, WISP or supporting reference. */
export const references = index as Reference[];

export const referencePath = (file: string) => {
  const canonical = numbering.find((entry) => entry.oldFile === file)?.file ?? file;
  return `/developers/wisps/${canonical.replace(/\.md$/, "").toLowerCase()}`;
};

export function findReference(slug: string): Reference | undefined {
  return references.find((ref) => ref.slug === slug || ref.aliases.includes(slug));
}

/** Only known local docs become reader routes. Other relative references identify repository source. */
export function resolveReferenceUrl(url: string, sourcePath: string): string {
  if (/^(?:https?:|mailto:)/i.test(url) || url.startsWith("#")) return url;
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith("//")) return "";
  if (url.startsWith("/")) return url;
  const hashAt = url.indexOf("#");
  const target = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : url.slice(hashAt);
  const parts = sourcePath.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  const normalized = parts.join("/");
  const found = references.find((ref) => ref.sourcePath === normalized || ref.aliases.some((slug) => `docs/wisps/${slug}.md` === normalized));
  return found
    ? referencePath(found.file) + hash
    : `https://github.com/MiguelMedeiros/ghostly/blob/dev/${normalized}${hash}`;
}

import type { Metadata } from "next";
import { findReference, references } from "@/lib/references";
import { findWisp } from "@/lib/wisps";
import { pageMetadata } from "@/lib/pageMeta";

export function readerParams(): Array<{ slug: string }> {
  return references.flatMap((ref) => [ref.slug, ...ref.aliases].map((slug) => ({ slug })));
}

export function readerMetadata(slug: string): Metadata {
  const ref = findReference(slug);
  if (!ref) return { title: "Not found" };
  const w = findWisp(ref.slug);
  return pageMetadata({
    title: w ? `WISP ${w.number} · ${w.name}` : ref.title,
    description: w?.benefit ?? ref.summary ?? `Ghostly reference: ${ref.title}`,
    path: `/wisps/${ref.slug}`,
  });
}

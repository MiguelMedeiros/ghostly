import { readFile } from "node:fs/promises";
import path from "node:path";
import { wisps } from "@/lib/catalog";
import "@/app/reference.css";
import type { Metadata } from "next";
import { Shell, Eyebrow } from "@/components/presentation/Shell";
import { Catalog } from "@/components/presentation/Catalog";
export const metadata: Metadata = {
  title: "WISP catalogue",
  description:
    "Draft contracts, with specification status, client scope and implementation evidence kept separate.",
  alternates: { canonical: "/developers/catalog" },
};
export default async function CatalogPage() {
  const bodies = Object.fromEntries(await Promise.all(wisps.map(async (w) => [w.number, await readFile(path.join(process.cwd(), "public/reference", w.file), "utf8")])));
  return (
    <Shell active="developers">
      <section className="p-wrap p-page-top">
        <Eyebrow>THE WORKING CATALOGUE · REVIEWED 22 SEP 2026</Eyebrow>
        <h1>
          One contract.
          <br />
          <em>Many implementations.</em>
        </h1>
        <p className="p-lead">Find the agreement behind a capability.</p>
        <div className="p-notice">
          All WISPs are <strong>Draft</strong>. Documents are grouped by independent capability families.
          Numbering does not change protocol identifiers. An implemented feature is
          not proof of full draft conformance.
        </div>
        <Catalog bodies={bodies} />
        <p className="p-footnote">
          Source snapshots come from this checkout.{" "}
          <a href="/developers/wisps/readme">Catalogue source</a> ·{" "}
          <a href="/developers/wisps/paired-capabilities">Paired capabilities</a>
        </p>
      </section>
    </Shell>
  );
}

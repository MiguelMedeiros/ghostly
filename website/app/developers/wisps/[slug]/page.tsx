import GithubSlugger from "github-slugger";
import numbering from "@/lib/wisp-numbering.json";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Shell } from "@/components/presentation/Shell";
import { ReferenceMarkdown } from "@/components/presentation/ReferenceMarkdown";
import { references, referencePath } from "@/lib/references";
import { wisps } from "@/lib/catalog";
import "@/app/reference.css";
export const dynamicParams = false;
export function generateStaticParams(): Array<{ slug:string }> {
  return references.flatMap((ref) => [ref.slug, ...ref.aliases].map((slug) => ({ slug })));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const ref = references.find((item) => item.slug === slug || item.aliases.includes(slug));
  return {
    title: ref?.title ?? "Reference not found",
    alternates: { canonical: `/developers/wisps/${ref?.slug ?? slug}` },
  };
}
export default async function WispPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const ref = references.find((item) => item.slug === slug || item.aliases.includes(slug));
  if (!ref) notFound();
  const body = await readFile(
    path.join(process.cwd(), "public/reference", ref.file),
    "utf8",
  );
  const wisp = wisps.find((item) => item.file === ref.file);
  const index = wisp ? wisps.indexOf(wisp) : -1;
  const former = numbering.find((entry) => entry.file === ref.file && entry.oldFile !== entry.file);
  const legacyHeading = former ? new GithubSlugger().slug(ref.title.replace(`WISP ${wisp?.displayNumber ?? former.id}`, `WISP ${former.oldId}`)) : undefined;
  return (
    <Shell active="developers">
      <div className="p-wrap reference-shell">
        <nav
          className="reference-breadcrumb"
          aria-label="Documentation breadcrumb"
        >
          <Link href="/developers">Developers</Link>
          <span>/</span>
          <Link href="/developers/catalog">WISP catalogue</Link>
          <span>/</span>
          <span>{wisp ? `WISP ${wisp.displayNumber}` : "Reference"}</span>
        </nav>
        <div className="reference-layout">
          <aside className="reference-sidebar">
            <details open>
              <summary>All WISP drafts</summary>
              <nav aria-label="WISP documents">
                {wisps.map((item) => (
                  <Link
                    key={item.number}
                    href={referencePath(item.file)}
                    aria-current={
                      wisp?.number === item.number ? "page" : undefined
                    }
                  >
                    <span>{item.displayNumber}</span>
                    {item.title}
                  </Link>
                ))}
              </nav>
            </details>
          </aside>
          <div className="reference-main">
            <div className="reference-status">
              <span className="p-status">
                {wisp
                  ? `Draft · ${wisp.displayNumber}${wisp.numberAssignment === "unassigned" ? " · Planned · number to be defined" : ""}`
                  : "Supporting reference"}
              </span>
              <a href={`/reference/${ref.file}`} download>
                Download Markdown ↓
              </a>
            </div>
            <p className="reference-scope">
              {wisp
                ? "A review draft, not a final standard or a guarantee of client support."
                : "Supporting documentation includes dated proposals and historical evidence."}{" "}
              <Link href="/developers#availability">
                Current client scope ↗
              </Link>
            </p>
            {slug !== ref.slug && (<p className="p-notice">This draft has moved to <Link href={referencePath(ref.file)}>its current number</Link>. Its status remains Draft.</p>)}
            <article className="reference-prose">
              {legacyHeading && <span id={legacyHeading} />}
              {wisp && wisp.displayNumber !== wisp.number && <span id={new GithubSlugger().slug(ref.title.replace(`WISP ${wisp.displayNumber}`, `WISP ${wisp.number}`))} />}
              <ReferenceMarkdown body={body} sourcePath={ref.sourcePath} />
            </article>
            <nav className="reference-next" aria-label="Continue reading">
              {index > 0 && (
                <Link href={referencePath(wisps[index - 1].file)}>
                  ← {wisps[index - 1].displayNumber} · {wisps[index - 1].title}
                </Link>
              )}
              {index >= 0 && index < wisps.length - 1 && (
                <Link href={referencePath(wisps[index + 1].file)}>
                  {wisps[index + 1].displayNumber} · {wisps[index + 1].title} →
                </Link>
              )}
              <Link href="/developers/catalog">Back to catalogue</Link>
            </nav>
          </div>
        </div>
      </div>
    </Shell>
  );
}

import { Nav } from "@/components/site/Nav";
import { SiteFooter } from "@/components/site/Footer";
import { GhostPet } from "@/components/site/GhostPet";
import { REPO_URL } from "@/content/shell";

/** The layout of the two legal pages, /privacy and /terms: a title, the date, a lead, then short sections. */
export function LegalPage({
  title,
  updated,
  lead,
  children,
}: {
  title: string;
  updated: string;
  lead: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <Nav />
      <main id="content" className="pt-16 bg-[#060a10] min-h-screen">
        <div className="max-w-3xl mx-auto px-4 py-16">
          <h1 className="text-4xl md:text-5xl font-bold mb-3 bg-gradient-to-r from-cyan-400 to-cyan-300 bg-clip-text text-transparent">
            {title}
          </h1>
          <p className="text-gray-500 mb-12 font-mono text-sm">Last updated: {updated}</p>
          <div className="text-lg text-gray-300 leading-relaxed mb-12 space-y-4">{lead}</div>
          {children}
        </div>
      </main>
      <SiteFooter />
      <GhostPet />
    </>
  );
}

export function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mb-12 scroll-mt-24">
      <h2 className="text-2xl font-semibold text-gray-100 mb-4">{title}</h2>
      <div className="space-y-4 text-gray-400 leading-relaxed">{children}</div>
    </section>
  );
}

/** A term in bold at the start of a list item. */
export function Term({ children }: { children: React.ReactNode }) {
  return <strong className="text-gray-200">{children}</strong>;
}

export function Code({ children }: { children: React.ReactNode }) {
  return <code className="text-cyan-400 text-sm">{children}</code>;
}

export function A({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith("http");
  return (
    <a
      href={href}
      className="text-cyan-400 hover:text-cyan-300 underline underline-offset-4"
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {children}
    </a>
  );
}

/** The all-caps paragraphs of a disclaimer, set a little apart so they read as one block. */
export function Caps({ children }: { children: React.ReactNode }) {
  return <p className="text-gray-300 text-sm leading-relaxed border-l-2 border-cyan-900 pl-4">{children}</p>;
}

export const ISSUES_URL = `${REPO_URL}/issues`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

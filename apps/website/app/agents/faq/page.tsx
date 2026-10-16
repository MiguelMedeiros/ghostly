import type { Metadata } from "next";
import { Fragment } from "react";
import { A, Code, LegalPage, Section } from "@/components/site/Legal";
import { agentsFaq, plainAnswer, type FaqLink } from "@/content/agents-faq";
import { SITE_URL, pageMetadata } from "@/lib/pageMeta";

const PATH = "/agents/faq";

export const metadata: Metadata = pageMetadata({ title: agentsFaq.meta.title, description: agentsFaq.meta.description, path: PATH });

/**
 * The questions and answers as FAQPage data (schema.org), for search engines and agents. The answers are the page's own
 * text, word for word. `<` is escaped so no answer can close the script element.
 */
const jsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  url: `${SITE_URL}${PATH}`,
  mainEntity: agentsFaq.items.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: plainAnswer(item.a) },
  })),
}).replace(/</g, "\\u003c");

/** An answer with its `code` parts shown as code. */
function Answer({ text }: { text: string }) {
  return (
    <p data-answer>
      {text.split("`").map((part, i) => (i % 2 ? <Code key={i}>{part}</Code> : <Fragment key={i}>{part}</Fragment>))}
    </p>
  );
}

function Links({ links }: { links: FaqLink[] }) {
  return (
    <p className="text-base">
      See:{" "}
      {links.map((link, i) => (
        <Fragment key={link.href}>
          {i > 0 && ", "}
          <A href={link.href}>{link.label}</A>
        </Fragment>
      ))}
    </p>
  );
}

export default function AgentsFaqPage() {
  return (
    <LegalPage title={agentsFaq.meta.title} updated={agentsFaq.updated} lead={<p>{agentsFaq.lead}</p>}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      {agentsFaq.items.map((item) => (
        <Section key={item.id} id={item.id} title={item.q}>
          <Answer text={item.a} />
          {item.links && <Links links={item.links} />}
        </Section>
      ))}
      <Section id="more" title="More for agents">
        <Links links={agentsFaq.more} />
      </Section>
    </LegalPage>
  );
}

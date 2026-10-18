import type { Metadata } from "next";
import { A, Code, LegalPage, Section } from "@/components/site/Legal";

const DESCRIPTION =
  "Put one Ghostly link on your site so people can write to you, without your name or any key of yours on the page. You choose whom to answer.";

export const metadata: Metadata = {
  title: "A contact link for your site",
  description: DESCRIPTION,
  alternates: { canonical: "/contact-link" },
  openGraph: {
    title: "A contact link for your site | Ghostly",
    description: DESCRIPTION,
    type: "article",
    url: "https://ghostly.tools/contact-link",
    images: [{ url: "https://ghostly.tools/og-image.png", width: 1200, height: 630, alt: "A Ghostly contact link" }],
  },
};

const UPDATED = "October 16, 2026";

/** How to put a contact link (WISP 8xx) on a site: make it, paste it, answer the requests. */
export default function ContactLinkPage() {
  return (
    <LegalPage
      title="A contact link for your site"
      updated={UPDATED}
      lead={
        <p>
          A contact link is one Ghostly link you can put on a website, a profile page or a business card so that anyone
          can write to you. It names nobody: no name, no key, nothing that ties it to you or to your chats. People who
          open it send you a request, and you choose whom to talk to.
        </p>
      }
    >
      <Section title="Make your link">
        <p>
          In Ghostly, open Settings, then Profile, and choose <strong>Make a contact link</strong>. Copy the link, or
          show its QR code. It looks like <Code>https://ghostly.tools/#ghostly1r…</Code>. From the command line,{" "}
          <Code>ghostly contact-link create</Code> does the same.
        </p>
      </Section>
      <Section title="Put it on your site">
        <p>Paste it as an ordinary link. For example:</p>
        <pre className="overflow-x-auto rounded-lg bg-white/5 p-3 text-sm text-cyan-400"><code>{`<a href="https://ghostly.tools/#ghostly1r…">Write to me on Ghostly</a>`}</code></pre>
        <p>
          The part after <Code>#</Code> never reaches a server: browsers do not send it, and this site takes it out of
          the address before anything else runs. Whoever opens the link is asked to open Ghostly, where they write their
          name and a short message. Nothing is sent until they tap Send.
        </p>
      </Section>
      <Section title="Answer the requests">
        <p>
          Requests wait in <strong>Requests</strong>, above your chat list, apart from your chats. <strong>Accept</strong>{" "}
          starts a chat like any other. <strong>Decline</strong> sends nothing back, and that person cannot ask again
          through the same link. Names are what each person typed: nobody checked them.
        </p>
        <p>
          A request waits on the network while you are away, for as long as the sender&apos;s app keeps it up, at most
          seven days. When too many wait at once, the link says it is busy and you see how many people tried, not what
          they wrote.
        </p>
      </Section>
      <Section title="Change it or turn it off">
        <p>
          Make a new link and the old one stops: whoever opens it is told it was turned off. You can also turn it off
          without making another. One link per profile at a time.
        </p>
        <p>
          How it works on the wire is in <A href="/wisps">the WISPs</A>, under Invites.
        </p>
      </Section>
    </LegalPage>
  );
}

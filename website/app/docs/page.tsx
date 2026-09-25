import { ProtocolDocs } from "@/components/ProtocolDocs";
import { Nav } from "@/components/site/Nav";
import { SiteFooter } from "@/components/site/Footer";
import { GhostPet } from "@/components/site/GhostPet";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Protocol Documentation",
  description:
    "Record-format guide for Ghostly's compatibility chats (the Ghostly 0.4 profile). DNS TXT records, encryption schemes, message formats, and call signaling over the Mainline DHT.",
  openGraph: {
    title: "Protocol Documentation | Ghostly",
    description:
      "Record-format guide for Ghostly's compatibility chats (the Ghostly 0.4 profile). DNS TXT records, encryption, and message formats.",
    type: "article",
    url: "https://ghostly.tools/docs",
    images: [
      {
        url: "https://ghostly.tools/og-image.png",
        width: 1200,
        height: 630,
        alt: "Ghostly Protocol Documentation",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Protocol Documentation | Ghostly",
    description:
      "Record-format guide for Ghostly's compatibility chats (the Ghostly 0.4 profile). DNS TXT records, encryption, and message formats.",
    images: ["https://ghostly.tools/og-image.png"],
  },
};

export default function DocsPage() {
  return (
    <>
      <Nav locale="en" />
      <main id="content" className="pt-16">
        <aside className="mx-auto mt-8 max-w-5xl border-l-2 border-cyan bg-cyan/5 px-6 py-4 text-sm text-gray-300">
          This guide describes the record and signaling profile of compatibility
          chats, the ones with Ghostly 0.4 contacts (WISP 402). For the one chat
          every new conversation uses, client limits and draft contracts, visit
          the{" "}
          <Link className="text-cyan underline" href="/developers">
            developer overview
          </Link>
          .
        </aside>
        <ProtocolDocs />
      </main>
      <SiteFooter />
      <GhostPet />
    </>
  );
}

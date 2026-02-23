import { ProtocolDocs } from "@/components/ProtocolDocs";
import { DocsNavbar } from "@/components/DocsNavbar";
import { Footer } from "@/components/Footer";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Protocol Documentation",
  description:
    "Complete protocol specification for Ghostly. DNS TXT records, encryption schemes, message formats, and call signaling over the Mainline DHT.",
  openGraph: {
    title: "Protocol Documentation — Ghostly",
    description:
      "Complete protocol specification for Ghostly. DNS TXT records, encryption, and message formats.",
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
    title: "Protocol Documentation — Ghostly",
    description:
      "Complete protocol specification for Ghostly. DNS TXT records, encryption, and message formats.",
    images: ["https://ghostly.tools/og-image.png"],
  },
};

export default function DocsPage() {
  return (
    <>
      <DocsNavbar />
      <main className="pt-16">
        <ProtocolDocs />
      </main>
      <Footer />
    </>
  );
}

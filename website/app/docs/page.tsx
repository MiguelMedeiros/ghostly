import { ProtocolDocs } from "@/components/ProtocolDocs";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Protocol Documentation — Ghostly",
  description:
    "Complete protocol specification for Ghostly. DNS TXT records, encryption schemes, message formats, and call signaling over the Mainline DHT.",
};

export default function DocsPage() {
  return (
    <>
      <Navbar />
      <main className="pt-16">
        <ProtocolDocs />
      </main>
      <Footer />
    </>
  );
}

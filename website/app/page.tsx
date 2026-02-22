import { Hero } from "@/components/Hero";
import { WhatIs } from "@/components/WhatIs";
import { HowItWorks } from "@/components/HowItWorks";
import { Features } from "@/components/Features";
import { ProtocolDeepDive } from "@/components/ProtocolDeepDive";
import { AppPreview } from "@/components/AppPreview";
import { Download } from "@/components/Download";
import { Footer } from "@/components/Footer";
import { Navbar } from "@/components/Navbar";

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <WhatIs />
        <HowItWorks />
        <Features />
        <ProtocolDeepDive />
        <AppPreview />
        <Download />
      </main>
      <Footer />
    </>
  );
}

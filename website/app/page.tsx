import { Hero } from "@/components/Hero";
import { AppPreview } from "@/components/AppPreview";
import { WhatIs } from "@/components/WhatIs";
import { ELI5 } from "@/components/ELI5";
import { HowItWorks } from "@/components/HowItWorks";
import { Features } from "@/components/Features";
import { CLISection } from "@/components/CLISection";
import { ProtocolDeepDive } from "@/components/ProtocolDeepDive";
import { FAQ } from "@/components/FAQ";
import { Download } from "@/components/Download";
import { Footer } from "@/components/Footer";
import { Navbar } from "@/components/Navbar";
import GhostPet from "@/components/GhostPet";

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <AppPreview />
        <WhatIs />
        <ELI5 />
        <HowItWorks />
        <Features />
        <CLISection />
        <ProtocolDeepDive />
        <FAQ />
        <Download />
      </main>
      <Footer />
      <GhostPet />
    </>
  );
}

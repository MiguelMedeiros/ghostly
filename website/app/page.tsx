import { Hero } from "@/components/Hero";
import { WhatIs } from "@/components/WhatIs";
import { ELI5 } from "@/components/ELI5";
import { HowItWorks } from "@/components/HowItWorks";
import { Features } from "@/components/Features";
import { ProtocolDeepDive } from "@/components/ProtocolDeepDive";
import { FAQ } from "@/components/FAQ";
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
        <ELI5 />
        <HowItWorks />
        <Features />
        <ProtocolDeepDive />
        <FAQ />
        <Download />
      </main>
      <Footer />
    </>
  );
}

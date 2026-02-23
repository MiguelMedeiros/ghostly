import { CLINavbar } from "@/components/cli/CLINavbar";
import { Footer } from "@/components/Footer";
import { CLIHero } from "@/components/cli/CLIHero";
import { CLIInstall } from "@/components/cli/CLIInstall";
import { CLISkillInstall } from "@/components/cli/CLISkillInstall";
import { CLIUseCases } from "@/components/cli/CLIUseCases";
import { CLIExamples } from "@/components/cli/CLIExamples";
import { CLIReference } from "@/components/cli/CLIReference";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Ghostly CLI — Ghost Protocol for Bots",
  description:
    "CLI tool for bots and automation. Send and receive encrypted ephemeral messages from scripts, AI agents, and automation tools.",
  openGraph: {
    title: "Ghostly CLI — Ghost Protocol for Bots",
    description:
      "CLI tool for bots and automation. Encrypted ephemeral messaging for scripts and AI agents.",
    type: "website",
    url: "https://ghostly.tools/cli",
    images: [
      {
        url: "https://ghostly.tools/og-image.png",
        width: 1200,
        height: 630,
        alt: "Ghostly CLI - Ghost Protocol for Bots",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Ghostly CLI — Ghost Protocol for Bots",
    description:
      "CLI tool for bots and automation. Encrypted ephemeral messaging for scripts and AI agents.",
    images: ["https://ghostly.tools/og-image.png"],
  },
};

export default function CLIPage() {
  return (
    <>
      <CLINavbar />
      <main>
        <CLIHero />
        <CLIInstall />
        <CLISkillInstall />
        <CLIUseCases />
        <CLIExamples />
        <CLIReference />
      </main>
      <Footer />
    </>
  );
}

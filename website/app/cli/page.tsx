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

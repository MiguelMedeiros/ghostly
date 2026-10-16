import type { Metadata } from "next";
import { pageMetadata } from "@/lib/pageMeta";
import { ThreatModelPage } from "@/components/agents/ThreatModelPage";
import { threat } from "@/content/agentsThreat";

export const metadata: Metadata = pageMetadata({ title: threat.meta.title, description: threat.meta.description, path: "/developers/agents/threat-model" });

export default function Page() {
  return <ThreatModelPage />;
}

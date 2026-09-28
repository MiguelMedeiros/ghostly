import type { Metadata } from "next";
import { AgentsPage } from "@/components/agents/AgentsPage";
import { agents } from "@/content/agents";

export const metadata: Metadata = {
  title: agents.meta.title,
  description: agents.meta.description,
  alternates: { canonical: "/developers/agents" },
};

export default function Page() {
  return <AgentsPage />;
}

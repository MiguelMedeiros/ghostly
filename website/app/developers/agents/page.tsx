import type { Metadata } from "next";
import { pageMetadata } from "@/lib/pageMeta";
import { AgentsPage } from "@/components/agents/AgentsPage";
import { agents } from "@/content/agents";

export const metadata: Metadata = pageMetadata({ title: agents.meta.title, description: agents.meta.description, path: "/developers/agents" });

export default function Page() {
  return <AgentsPage />;
}

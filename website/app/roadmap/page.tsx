import type { Metadata } from "next";
import { pageMetadata } from "@/lib/pageMeta";
import { RoadmapPage } from "@/components/roadmap/RoadmapPage";
import { roadmap } from "@/content/roadmap";

export const metadata: Metadata = pageMetadata({ title: roadmap.meta.title, description: roadmap.meta.description, path: "/roadmap" });

export default function Page() {
  return <RoadmapPage />;
}

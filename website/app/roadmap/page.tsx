import type { Metadata } from "next";
import { RoadmapPage } from "@/components/roadmap/RoadmapPage";
import { roadmap } from "@/content/roadmap";

export const metadata: Metadata = {
  title: roadmap.meta.title,
  description: roadmap.meta.description,
  alternates: { canonical: "/roadmap" },
};

export default function Page() {
  return <RoadmapPage />;
}

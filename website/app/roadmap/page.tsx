import type { Metadata } from "next";
import { RoadmapPage } from "@/components/roadmap/RoadmapPage";
import { roadmap } from "@/content/roadmap";
import { alternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: roadmap.en.meta.title,
  description: roadmap.en.meta.description,
  alternates: alternates("/roadmap", "en"),
};

export default function Page() {
  return <RoadmapPage locale="en" />;
}

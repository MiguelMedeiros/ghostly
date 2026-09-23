import type { Metadata } from "next";
import { RoadmapPage } from "@/components/roadmap/RoadmapPage";
import { roadmap } from "@/content/roadmap";
import { alternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: roadmap["pt-br"].meta.title,
  description: roadmap["pt-br"].meta.description,
  alternates: alternates("/roadmap", "pt-br"),
};

export default function Page() {
  return <RoadmapPage locale="pt-br" />;
}

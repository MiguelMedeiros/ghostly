import type { Metadata } from "next";
import { DevelopersPage } from "@/components/dev/DevelopersPage";
import { developers } from "@/content/developers";
import { alternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: developers.en.meta.title,
  description: developers.en.meta.description,
  alternates: alternates("/developers", "en"),
};

export default function Page() {
  return <DevelopersPage locale="en" />;
}

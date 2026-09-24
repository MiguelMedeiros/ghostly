import type { Metadata } from "next";
import { DevelopersPage } from "@/components/dev/DevelopersPage";
import { developers } from "@/content/developers";
import { alternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: developers["pt-br"].meta.title,
  description: developers["pt-br"].meta.description,
  alternates: alternates("/developers", "pt-br"),
};

export default function Page() {
  return <DevelopersPage locale="pt-br" />;
}

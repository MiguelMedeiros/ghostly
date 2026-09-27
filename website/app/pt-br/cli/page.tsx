import type { Metadata } from "next";
import { CliPage } from "@/components/cli/CliPage";
import { cli } from "@/content/cli";
import { alternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: cli["pt-br"].meta.title,
  description: cli["pt-br"].meta.description,
  alternates: alternates("/cli", "pt-br"),
};

export default function Page() {
  return <CliPage locale="pt-br" />;
}

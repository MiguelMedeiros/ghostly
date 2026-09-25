import type { Metadata } from "next";
import { HomePage } from "@/components/home/HomePage";
import { home } from "@/content/home";
import { alternates } from "@/lib/i18n";
import { latestRelease } from "@/lib/latestRelease";

export const metadata: Metadata = {
  title: { absolute: home["pt-br"].meta.title },
  description: home["pt-br"].meta.description,
  alternates: alternates("/", "pt-br"),
  openGraph: { locale: "pt_BR", title: home["pt-br"].meta.title, description: home["pt-br"].meta.description },
};

export default async function Page() {
  return <HomePage locale="pt-br" version={await latestRelease()} />;
}

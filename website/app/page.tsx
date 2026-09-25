import type { Metadata } from "next";
import { HomePage } from "@/components/home/HomePage";
import { home } from "@/content/home";
import { alternates } from "@/lib/i18n";
import { latestRelease } from "@/lib/latestRelease";

export const metadata: Metadata = {
  title: { absolute: home.en.meta.title },
  description: home.en.meta.description,
  alternates: alternates("/", "en"),
};

export default async function Page() {
  return <HomePage locale="en" version={await latestRelease()} />;
}

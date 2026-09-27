import type { Metadata } from "next";
import { HomePage } from "@/components/home/HomePage";
import { home } from "@/content/home";
import { latestRelease } from "@/lib/latestRelease";

export const metadata: Metadata = {
  title: { absolute: home.meta.title },
  description: home.meta.description,
  alternates: { canonical: "/" },
};

export default async function Page() {
  return <HomePage version={await latestRelease()} />;
}

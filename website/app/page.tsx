import type { Metadata } from "next";
import { pageMetadata } from "@/lib/pageMeta";
import { HomePage } from "@/components/home/HomePage";
import { home } from "@/content/home";
import { latestRelease } from "@/lib/latestRelease";

export const metadata: Metadata = pageMetadata({ title: home.meta.title, description: home.meta.description, path: "/", absolute: true });

export default async function Page() {
  return <HomePage version={await latestRelease()} />;
}

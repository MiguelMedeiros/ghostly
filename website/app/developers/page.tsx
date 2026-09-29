import type { Metadata } from "next";
import { pageMetadata } from "@/lib/pageMeta";
import { DevelopersPage } from "@/components/dev/DevelopersPage";
import { developers } from "@/content/developers";

export const metadata: Metadata = pageMetadata({ title: developers.meta.title, description: developers.meta.description, path: "/developers" });

export default function Page() {
  return <DevelopersPage />;
}

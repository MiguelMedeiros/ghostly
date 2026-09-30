import type { Metadata } from "next";
import { pageMetadata } from "@/lib/pageMeta";
import { CatalogPage } from "@/components/catalog/CatalogPage";
import { catalog } from "@/content/catalog";

export const metadata: Metadata = pageMetadata({ title: catalog.meta.title, description: catalog.meta.description, path: "/wisps" });

export default function Page() {
  return <CatalogPage />;
}

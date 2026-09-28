import type { Metadata } from "next";
import { CatalogPage } from "@/components/catalog/CatalogPage";
import { catalog } from "@/content/catalog";

export const metadata: Metadata = {
  title: catalog.meta.title,
  description: catalog.meta.description,
  alternates: { canonical: "/developers/wisps" },
};

export default function Page() {
  return <CatalogPage />;
}

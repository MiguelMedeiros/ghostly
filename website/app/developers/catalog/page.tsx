import type { Metadata } from "next";
import { CatalogPage } from "@/components/catalog/CatalogPage";
import { catalog } from "@/content/catalog";
import { alternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: catalog.en.meta.title,
  description: catalog.en.meta.description,
  alternates: alternates("/developers/catalog", "en"),
};

export default function Page() {
  return <CatalogPage locale="en" />;
}

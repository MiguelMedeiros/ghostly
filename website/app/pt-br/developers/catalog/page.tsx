import type { Metadata } from "next";
import { CatalogPage } from "@/components/catalog/CatalogPage";
import { catalog } from "@/content/catalog";
import { alternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: catalog["pt-br"].meta.title,
  description: catalog["pt-br"].meta.description,
  alternates: alternates("/developers/catalog", "pt-br"),
};

export default function Page() {
  return <CatalogPage locale="pt-br" />;
}

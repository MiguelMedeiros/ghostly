import type { Metadata } from "next";
import { pageMetadata } from "@/lib/pageMeta";
import { BrandPage } from "@/components/brand/BrandPage";
import { brandPage } from "@/content/brand";

export const metadata: Metadata = pageMetadata({ title: brandPage.meta.title, description: brandPage.meta.description, path: "/brand" });

export default function Page() {
  return <BrandPage />;
}

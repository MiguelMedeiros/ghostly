import type { Metadata } from "next";
import { DevelopersPage } from "@/components/dev/DevelopersPage";
import { developers } from "@/content/developers";

export const metadata: Metadata = {
  title: developers.meta.title,
  description: developers.meta.description,
  alternates: { canonical: "/developers" },
};

export default function Page() {
  return <DevelopersPage />;
}

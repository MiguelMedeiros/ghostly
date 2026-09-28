import type { Metadata } from "next";
import { NotFoundScene } from "@/components/site/NotFoundScene";

// A title of its own, so a missing page never reads as the home page in a tab or a share.
export const metadata: Metadata = {
  title: "Page not found",
  description: "This page is not on ghostly.tools. The home page and the WISPs are one click away.",
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return <NotFoundScene />;
}

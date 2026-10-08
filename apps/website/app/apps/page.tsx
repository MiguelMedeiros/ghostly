import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppsPage } from "@/components/apps/AppsPage";
import { apps } from "@/content/apps";
import { appsReleased } from "@/lib/appsGate";
import { pageMetadata } from "@/lib/pageMeta";
import { storeView } from "@/lib/store";

// Rendered for each visit: the release gate follows the latest release (asked at most once an hour, lib/latestRelease.ts),
// and the store is the one the build read and checked (lib/store.ts). Nothing here asks GitHub per visit.
export const revalidate = 0;

export async function generateMetadata(): Promise<Metadata> {
  if (!(await appsReleased())) return {};
  return pageMetadata({ title: apps.meta.title, description: apps.meta.description, path: "/apps" });
}

export default async function Page() {
  if (!(await appsReleased())) notFound();
  return <AppsPage store={storeView()} />;
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppPage } from "@/components/apps/AppPage";
import { appsReleased } from "@/lib/appsGate";
import { pageMetadata } from "@/lib/pageMeta";
import { storeApp, storeView } from "@/lib/store";

// As /apps: rendered for each visit, from the store the build read and checked.
export const revalidate = 0;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const app = (await appsReleased()) ? storeApp((await params).slug) : undefined;
  if (!app) return {};
  return pageMetadata({ title: `${app.title}: Ghostly app`, description: app.tagline, path: `/apps/${app.slug}` });
}

export default async function Page({ params }: Props) {
  if (!(await appsReleased())) notFound();
  const app = storeApp((await params).slug);
  const store = storeView();
  if (!app || !store.ok) notFound();
  return <AppPage app={app} store={store.name} />;
}

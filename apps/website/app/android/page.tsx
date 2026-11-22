import type { Metadata } from "next";
import { pageMetadata } from "@/lib/pageMeta";
import { AndroidPage } from "@/components/android/AndroidPage";
import { android } from "@/content/android";
import { latestRelease } from "@/lib/latestRelease";
import { ANDROID_PAGE } from "@/lib/release";

export const metadata: Metadata = pageMetadata({ title: android.meta.title, description: android.meta.description, path: ANDROID_PAGE });

export default async function Page() {
  return <AndroidPage version={await latestRelease()} />;
}

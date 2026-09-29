import type { Metadata } from "next";
import { pageMetadata } from "@/lib/pageMeta";
import { CliPage } from "@/components/cli/CliPage";
import { cli } from "@/content/cli";

export const metadata: Metadata = pageMetadata({ title: cli.meta.title, description: cli.meta.description, path: "/cli" });

export default function Page() {
  return <CliPage />;
}

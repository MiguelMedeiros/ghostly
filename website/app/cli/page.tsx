import type { Metadata } from "next";
import { CliPage } from "@/components/cli/CliPage";
import { cli } from "@/content/cli";

export const metadata: Metadata = {
  title: cli.meta.title,
  description: cli.meta.description,
  alternates: { canonical: "/cli" },
};

export default function Page() {
  return <CliPage />;
}

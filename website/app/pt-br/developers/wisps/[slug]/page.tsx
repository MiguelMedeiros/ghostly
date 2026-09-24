import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReaderPage } from "@/components/reader/ReaderPage";
import { readerMetadata, readerParams } from "@/components/reader/route";
import { findReference } from "@/lib/references";

export const dynamicParams = false;
export const generateStaticParams = readerParams;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  return readerMetadata((await params).slug, "pt-br");
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const reference = findReference(slug);
  if (!reference) notFound();
  return <ReaderPage reference={reference} requested={slug} locale="pt-br" />;
}

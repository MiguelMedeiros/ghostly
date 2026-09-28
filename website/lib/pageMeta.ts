import type { Metadata } from "next";

export const SITE_URL = "https://ghostly.tools";
export const SITE_NAME = "Ghostly";

/** The one share image: 1200x630, the size Open Graph and X read without cropping. */
export const OG_IMAGE = {
  url: `${SITE_URL}/og-image.png`,
  width: 1200,
  height: 630,
  alt: "Ghostly: two friendly ghosts, Boo and Casper, talking peer to peer",
  type: "image/png",
};

/**
 * A page's title, description, canonical address and share card. Next does not merge `openGraph` or `twitter` into the
 * layout's, so a page that set only a title shared the home page's card: every field is here, every time.
 */
export function pageMetadata({ title, description, path, absolute = false }: { title: string; description: string; path: string; absolute?: boolean }): Metadata {
  const full = absolute ? title : `${title} | ${SITE_NAME}`;
  const url = path === "/" ? SITE_URL : `${SITE_URL}${path}`;
  return {
    title: absolute ? { absolute: title } : title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: path === "/" ? "website" : "article",
      locale: "en_US",
      siteName: SITE_NAME,
      url,
      title: full,
      description,
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: full,
      description,
      images: [OG_IMAGE.url],
    },
  };
}

"use client";

import type { ComponentProps } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * A link in a long list of pages (the WISP map, the reader's panel, the developers page, the apps of /apps) or on every
 * page (the nav, the footer, a WISP's breadcrumb): it loads its page when the reader is about to open it (pointer,
 * focus, touch), not as it scrolls into view. A page with dozens of them does not fetch them all, and a page that is
 * only read does not load the scripts of the pages it links to (the home's alone is 41 KB on the wire).
 */
export function IntentLink({ href, onMouseEnter, onFocus, onTouchStart, ...rest }: Omit<ComponentProps<typeof Link>, "href" | "prefetch"> & { href: string }) {
  const router = useRouter();
  const load = () => router.prefetch(href);
  return (
    <Link
      {...rest}
      href={href}
      prefetch={false}
      onMouseEnter={(e) => { load(); onMouseEnter?.(e); }}
      onFocus={(e) => { load(); onFocus?.(e); }}
      onTouchStart={(e) => { load(); onTouchStart?.(e); }}
    />
  );
}

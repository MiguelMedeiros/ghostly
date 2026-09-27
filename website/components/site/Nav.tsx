"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Brand } from "./Brand";
import { shell, APP_URL } from "@/content/shell";

export function Nav() {
  const t = shell.nav;
  const pathname = usePathname() ?? "/";
  const [scrolled, setScrolled] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close the phone menu after navigating.
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [pathname]);

  // Escape closes it and hands focus back to its button.
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDetailsElement>) => {
    const el = menu.current;
    if (e.key !== "Escape" || !el?.open) return;
    e.preventDefault();
    el.open = false;
    el.querySelector("summary")?.focus();
  };

  const links = [
    { href: "/#story", label: t.story, match: null },
    { href: "/developers", label: t.developers, match: /^\/developers$/ },
    { href: "/developers/catalog", label: t.wisps, match: /^\/developers\/(catalog|wisps)/ },
    { href: "/roadmap", label: t.roadmap, match: /^\/roadmap/ },
    { href: "/cli", label: t.cli, match: /^\/cli/ },
  ];

  return (
    <header className="nav" data-scrolled={scrolled}>
      <div className="wrap nav-inner">
        <Link href={"/"} className="brand" aria-label="Ghostly home">
          <Brand />
        </Link>
        <nav className="nav-links" aria-label="Main">
          {links.map((l) => (
            <Link key={l.href} href={l.href} aria-current={l.match?.test(pathname) ? "page" : undefined}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="nav-end">
          <a className="btn btn--primary nav-cta" href={APP_URL}>
            {t.open}
          </a>
          <details className="nav-menu" ref={menu} onKeyDown={onMenuKeyDown}>
            <summary aria-label={t.menu}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
              </svg>
            </summary>
            <div className="nav-sheet">
              {links.map((l) => (
                <Link key={l.href} href={l.href}>
                  {l.label}
                </Link>
              ))}
              <a href={APP_URL}>{t.open} ↗</a>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}

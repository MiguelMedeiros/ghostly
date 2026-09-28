"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Brand } from "./Brand";
import { shell, APP_URL } from "@/content/shell";

/** The home page's download section: it puts the reader's own system first, then every other one and the extension. */
const DOWNLOAD_HREF = "/#download";

export function Nav() {
  const t = shell.nav;
  const pathname = usePathname() ?? "/";
  const [scrolled, setScrolled] = useState(false);
  const [openWays, setOpenWays] = useState(false);
  // The chevron only works once React runs: until then it is disabled, so an early click can't be lost.
  const [hydrated, setHydrated] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const ways = useRef<HTMLDivElement>(null);
  const waysButton = useRef<HTMLButtonElement>(null);

  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close the phone menu and the open menu after navigating. Not on the first render: the phone menu is a native
  // <details>, so a tap before hydration already opened it, and hydrating must not shut it.
  const shownPath = useRef(pathname);
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    if (menu.current) menu.current.open = false;
    setOpenWays(false);
  }, [pathname]);

  // The open menu closes on a click anywhere else.
  useEffect(() => {
    if (!openWays) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!ways.current?.contains(e.target as Node)) setOpenWays(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openWays]);

  // Escape closes the phone menu and hands focus back to its button.
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDetailsElement>) => {
    const el = menu.current;
    if (e.key !== "Escape" || !el?.open) return;
    e.preventDefault();
    el.open = false;
    el.querySelector("summary")?.focus();
  };

  const items = () => [...(ways.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const focusItem = (index: number) => {
    const all = items();
    all[(index + all.length) % all.length]?.focus();
  };
  const showWays = (focus: "first" | "last") => {
    setOpenWays(true);
    // The menu renders on the next frame; focus lands in it then.
    requestAnimationFrame(() => focusItem(focus === "first" ? 0 : -1));
  };
  const closeWays = () => {
    setOpenWays(false);
    waysButton.current?.focus();
  };

  const onWaysButtonKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      showWays(e.key === "ArrowDown" ? "first" : "last");
    }
  };
  const onWaysMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      closeWays();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusItem(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusItem(at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusItem(-1);
    } else if (e.key === "Tab") {
      setOpenWays(false);
    }
  };

  const links = [
    { href: "/#story", label: t.story, match: null },
    { href: "/developers", label: t.developers, match: /^\/developers$/ },
    { href: "/wisps", label: t.wisps, match: /^\/wisps/ },
    { href: "/roadmap", label: t.roadmap, match: /^\/roadmap/ },
    { href: "/cli", label: t.cli, match: /^\/cli/ },
    { href: "/developers/agents", label: t.agents, match: /^\/developers\/agents/ },
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
          {/* A split button: the main part opens the web app, the chevron offers the web app or a download. */}
          <div className="nav-open" ref={ways}>
            <a className="btn btn--primary nav-cta nav-open-main" href={APP_URL}>
              {t.open}
            </a>
            <button
              ref={waysButton}
              type="button"
              className="btn btn--primary nav-cta nav-open-more"
              aria-label={t.openWays}
              aria-haspopup="menu"
              aria-expanded={openWays}
              aria-controls="nav-open-menu"
              disabled={!hydrated}
              onClick={() => (openWays ? setOpenWays(false) : showWays("first"))}
              onKeyDown={onWaysButtonKeyDown}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden="true">
                <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {openWays && (
              <div id="nav-open-menu" className="nav-open-menu" role="menu" aria-label={t.openWays} onKeyDown={onWaysMenuKeyDown}>
                <a role="menuitem" tabIndex={-1} href={APP_URL}>
                  <span>{t.web.label}</span>
                  <small>{t.web.hint}</small>
                </a>
                <Link role="menuitem" tabIndex={-1} href={DOWNLOAD_HREF} onClick={() => setOpenWays(false)}>
                  <span>{t.download.label}</span>
                  <small>{t.download.hint}</small>
                </Link>
              </div>
            )}
          </div>
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
              <span className="nav-sheet-rule" aria-hidden="true" />
              <a className="nav-sheet-way" href={APP_URL}>
                {t.web.label} ↗
              </a>
              <Link className="nav-sheet-way" href={DOWNLOAD_HREF} onClick={() => menu.current && (menu.current.open = false)}>
                {t.download.label}
              </Link>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}

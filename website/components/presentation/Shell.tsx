import type { ReactNode } from "react";
import Link from "next/link";
import { HauntedPage, MotionToggle } from "../HauntedPage";
import { GhostGlyph } from "../icons";
import { GhostFinale } from "../story/GhostFinale";
import "@/app/landing.css";
import "@/app/story.css";
import "@/app/story-stage.css";
import "@/app/haunting.css";
import "@/app/presentation.css";
import "@/app/continuity.css";

export function Shell({
  children,
  active = "home",
  finale = false,
}: {
  children: ReactNode;
  active?: string;
  finale?: boolean;
}) {
  return (
    <HauntedPage>
      <div className="p-site">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="p-header">
          <div className="p-wrap p-nav">
            <Link href="/" aria-label="Ghostly home" className="p-brand">
              <GhostGlyph />
              Ghostly
            </Link>
            <nav aria-label="Main navigation">
              <Link href="/#possibilities">The app</Link>
              <Link
                href="/developers"
                aria-current={active === "developers" ? "page" : undefined}
              >
                For developers
              </Link>
              <Link
                href="/roadmap"
                aria-current={active === "roadmap" ? "page" : undefined}
              >
                Roadmap
              </Link>
            </nav>
            <a href="https://app.ghostly.tools" className="p-button small">
              Open app <span aria-hidden="true">↗</span>
            </a>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
          {finale && <GhostFinale />}
        </main>
        <footer className="p-footer p-wrap">
          <div>
            <Link href="/" className="p-brand">
              <GhostGlyph />
              ghostly.
            </Link>
            <p>A little protocol. A lot of possibilities.</p>
            <MotionToggle />
          </div>
          <nav aria-label="Footer navigation">
            <Link href="/developers/catalog">WISP catalogue</Link>
            <Link href="/docs">Documentation</Link>
            <a href="https://github.com/MiguelMedeiros/ghostly">GitHub ↗</a>
            <Link href="/privacy">Privacy</Link>
            <a href="https://miguelmedeiros.dev">Made by Miguel Medeiros ↗</a>
          </nav>
        </footer>
      </div>
    </HauntedPage>
  );
}
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="p-eyebrow">{children}</p>;
}

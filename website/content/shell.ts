import type { Level } from "@/lib/status";

export const APP_URL = "https://app.ghostly.tools";
export const REPO_URL = "https://github.com/MiguelMedeiros/ghostly";
/** The security policy and the contributing guide live on GitHub only, on the released branch. */
export const SECURITY_URL = `${REPO_URL}/blob/main/SECURITY.md`;
export const CONTRIBUTING_URL = `${REPO_URL}/blob/main/CONTRIBUTING.md`;

export const shell = {
    skip: "Skip to content",
    nav: {
      story: "How it works",
      developers: "Developers",
      wisps: "Protocol",
      roadmap: "Roadmap",
      cli: "CLI",
      agents: "AI agents",
      open: "Open app",
      openWays: "Ways to open Ghostly",
      web: { label: "Open in your browser", hint: "Nothing to install" },
      download: { label: "Download the app", hint: "macOS, Windows, Linux or the extension" },
      menu: "Menu",
    },
    footer: {
      tagline: "Find each other through Ghost. Then choose how to talk, what to share and how to trade value.",
      product: "Product",
      developers: "Developers",
      project: "Project",
      links: {
        open: "Open in your browser",
        download: "Download",
        privacy: "Privacy",
        overview: "Build with Ghostly",
        catalog: "Protocol",
        cli: "CLI",
        roadmap: "Roadmap",
        github: "GitHub",
        releases: "Releases",
        security: "Security",
        contributing: "Contributing",
      },
      haunt: "Haunting the internet with",
      made: "Made by",
      sleeping: "A ghost is sleeping here",
    },
    pet: "Hide the ghost",
    levels: {
      available: "Available",
      planned: "Planned",
      research: "Research",
    } satisfies Record<Level, string>,
    levelHelp: {
      available: "In the app today.",
      planned: "Designed or proposed. No working version yet.",
      research: "Being considered, not planned.",
    } satisfies Record<Level, string>,
    draft: "Draft",
    englishOnly: "This page is in English.",
};

export type ShellCopy = typeof shell;

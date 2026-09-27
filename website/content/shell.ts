import type { Level } from "@/lib/status";

export const APP_URL = "https://app.ghostly.tools";
export const REPO_URL = "https://github.com/MiguelMedeiros/ghostly";

export const shell = {
    skip: "Skip to content",
    nav: {
      story: "How it works",
      developers: "Developers",
      wisps: "WISPs",
      roadmap: "Roadmap",
      cli: "CLI",
      open: "Open app",
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
        catalog: "WISP catalog",
        protocol: "Protocol docs",
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
      research: "An open question we are investigating.",
    } satisfies Record<Level, string>,
    draft: "Draft",
    englishOnly: "This page is in English.",
};

export type ShellCopy = typeof shell;

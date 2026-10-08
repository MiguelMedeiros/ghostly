import { APP_CLIENTS, type AppClient, type AppPermission, type AppViewMode } from "@/lib/store-core/appBundle";
import { APP_URL } from "./shell";

/** The official store's repository: where apps are submitted, and where its index lives. */
export const STORE_REPO_URL = "https://github.com/MiguelMedeiros/ghostly-store";
export const SUBMIT_URL = `${STORE_REPO_URL}/blob/main/CONTRIBUTING.md`;

export const apps = {
  meta: {
    title: "Apps",
    description: "Games and small apps that run inside Ghostly, live in a chat with a contact. Signed by their makers, reviewed before they are listed, run in a sandbox.",
  },
  nav: "Apps",
  hero: {
    eyebrow: "Ghostly Store",
    title: "Apps for your chats",
    lead: "Games and small tools that run inside Ghostly, live in a chat with a contact. Every app is signed by its maker, reviewed before the store lists it, and runs in a sandbox.",
    open: "Open Ghostly",
    submit: "Submit an app",
  },
  where: "Apps need Ghostly 1.2 or later: on the web, or the desktop app for macOS and Linux. Not on Windows, the Android app or the browser extension yet.",
  list: {
    title: "In the store",
    count: (n: number) => (n === 1 ? "1 app" : `${n} apps`),
    empty: "The store lists no apps yet.",
    unavailable: "The store could not be read when this page was built. Open Ghostly to see its apps.",
    stale: (readAt: string, expires: string) =>
      `This list is the store as read on ${readAt}, and that copy lapsed on ${expires}. Ghostly reads the store itself.`,
    signed: "Signed by the store key",
  },
  app: {
    back: "All apps",
    by: "By",
    version: "Version",
    category: "Category",
    can: "What it can do",
    runs: "Where it runs",
    madeFor: "Made for",
    install: {
      title: "Install it in Ghostly",
      steps: (title: string, fingerprint: string) => [
        "Open Ghostly 1.2 or later: in your browser, or the desktop app on macOS or Linux.",
        "Go to Apps. The Ghostly Store is there already.",
        `Find ${title}, check that its publisher key starts with ${fingerprint}, and press Install.`,
        "Press Open and pick a chat, or start it from Apps in a chat. It runs with your contact, live.",
      ],
      open: "Open Ghostly",
      link: "Or add it by its link: Apps, Add, then paste",
    },
    publisher: {
      title: "Who signed it",
      lead: "Ghostly checks this signature again before it installs the app, and before every update.",
      key: "Publisher key",
      digest: "This version",
    },
    details: "Details",
    license: "License",
    source: "Source",
    support: "Support",
    notes: "What's new",
    listed: (store: string) => `Listed by ${store}, reviewed by its maintainers.`,
  },
};

/** What an app may do, as the install screen says it (WISP 1200 · Permissions). Every app keeps its own data. */
export const PERMISSIONS: Record<AppPermission | "storage", { label: string; info?: string }> = {
  storage: { label: "Keep its own data on this device, separately in each chat" },
  chat: { label: "Talk to the same app on your contact's side, while you are both in the chat" },
  name: { label: "See your name in the chat it is opened in" },
  internet: {
    label: "Use the internet",
    info: "The app and the servers it talks to can learn your IP address and what you do in it.",
  },
};

/** Said of every app without the internet permission (WISP 1200 · Permissions). */
export const NO_INTERNET = "No internet access. Its publisher may still learn your IP address and when you open it.";

export const VIEWS: Record<AppViewMode, string> = {
  chat: "Inside a one-to-one chat, with a contact who has it too.",
  full: "Full screen, on its own or from a chat.",
};

export const CLIENTS: Record<AppClient, string> = {
  web: "Web",
  desktop: "Desktop",
  extension: "Browser extension",
};

/**
 * A client's name on an app's page: the known ones in words, a later one (WISP 1200 · Manifest) as the manifest writes
 * it. Only the known names are looked up, so a name `CLIENTS` inherits (`constructor`) stays a name.
 */
export const clientLabel = (c: string): string => ((APP_CLIENTS as readonly string[]).includes(c) ? CLIENTS[c as AppClient] : c);

export { APP_URL };

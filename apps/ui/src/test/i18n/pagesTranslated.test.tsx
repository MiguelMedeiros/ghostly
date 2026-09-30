import { cleanup, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeleteProfileDialog } from "../../components/DeleteProfileDialog";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Home } from "../../pages/Home";
import { Profile } from "../../pages/Profile";
import { Services } from "../../pages/Services";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import { LANGUAGES, LOCALES, flatten } from "./locales";

// covers: app.i18n

/**
 * Pages whose words were written into the component rather than looked up with `t()`: the check here does not
 * compare with en.json (a literal is in no locale file), it compares what English shows with what another language
 * shows. A string that reads the same in both is one nobody translated, unless it is a name that stays as it is.
 */
const SAME_IN_EVERY_LANGUAGE = /^(?:Ghostly|GitHub|S3|Personal|Ana|Work|[A-Z]|[\d,.\s]+ sats|localhost:3400|[\d\s.,:·+↻…✓-]*|v?\d+\.\d+\.\d+.*)$/;

/** What a person sees or hears: text, and the labels screen readers and tooltips read out. */
function visibleStrings(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) out.push(node.nodeValue ?? "");
  for (const el of root.querySelectorAll("[title], [aria-label], [placeholder], [alt]"))
    for (const a of ["title", "aria-label", "placeholder", "alt"]) { const v = el.getAttribute(a); if (v) out.push(v); }
  return out.map((s) => s.trim()).filter((s) => s && !SAME_IN_EVERY_LANGUAGE.test(s));
}

type Screen = { name: string; share?: boolean; render: () => ReactElement; open?: (user: ReturnType<typeof renderApp>["user"]) => Promise<void> };

const chat = (id: string): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: id.repeat(52), encKeyB64: "enc", label: "Ana", messages: [], createdAt: 1 });

const SCREENS: Screen[] = [
  { name: "Profile, Back up open", render: () => <Profile />, open: async (user) => { await user.click(screen.getByTestId("backup-open")); } },
  { name: "Profile, Restore open", render: () => <Profile />, open: async (user) => { await user.click(screen.getByTestId("restore-open")); } },
  { name: "Profile, S3 storage open", render: () => <Profile />, open: async (user) => { await user.click(screen.getByTestId("s3-setup")); } },
  { name: "Profile on a host with profiles, a new one being named", render: () => <Profile />, open: async (user) => { await user.click(screen.getByTestId("profile-new")); } },
  { name: "Deleting a profile", render: () => <DeleteProfileDialog entry={{ id: "work", name: "Work", createdAt: 0 }} onClose={() => {}} /> },
  { name: "Services, where sharing needs another app", render: () => <Services /> },
  { name: "Services, sharing a local app", share: true, render: () => <Services />, open: async (user) => { await user.click(await screen.findByTestId("add-service")); } },
  { name: "Home", render: () => <Home /> },
  { name: "the chat list's search with nothing found", render: () => <UpdateProvider><Sidebar /></UpdateProvider>, open: async (user) => { await user.type(screen.getByRole("textbox"), "zzzz"); } },
];

beforeEach(() => { fakeEngine.features = { ...fakeEngine.features, profiles: true, shareLocalServices: false }; saveSession(chat("a")); });
afterEach(() => { fakeEngine.features = { ...fakeEngine.features, profiles: false, shareLocalServices: false }; });

async function stringsOf(entry: Screen, language: string): Promise<Set<string>> {
  fakeEngine.features = { ...fakeEngine.features, shareLocalServices: !!entry.share };
  const { user, container } = renderApp(entry.render(), { language: language as never });
  await entry.open?.(user);
  const strings = new Set([...visibleStrings(container), ...visibleStrings(document.body)]);
  cleanup();
  return strings;
}

describe.each(SCREENS)("$name", (entry) => {
  it.each(LANGUAGES.filter((l) => l !== "en"))("shows no English in %s", async (language) => {
    const english = await stringsOf(entry, "en");
    expect(english.size).toBeGreaterThan(0);
    const other = await stringsOf(entry, language);
    // A word a language writes as English does ("Auto", "Chat") is in its own locale file: that one is chosen.
    const own = new Set([...flatten(LOCALES[language as keyof typeof LOCALES]).values()].filter((v): v is string => typeof v === "string"));
    expect([...other].filter((s) => english.has(s) && !own.has(s))).toEqual([]);
  });
});

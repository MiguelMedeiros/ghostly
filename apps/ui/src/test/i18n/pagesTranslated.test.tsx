import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MessageDetailsView } from "@ghostly/browser/shared/types";
import { DeleteProfileDialog } from "../../components/DeleteProfileDialog";
import { MessageDetailsPanel } from "../../components/MessageDetailsPanel";
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

// covers: app.i18n, chat.paired.message-details

/**
 * Pages whose words were written into the component rather than looked up with `t()`: the check here does not
 * compare with en.json (a literal is in no locale file), it compares what English shows with what another language
 * shows. A string that reads the same in both is one nobody translated, unless it is a name that stays as it is.
 */
const SAME_IN_EVERY_LANGUAGE = /^(?:Ghostly|GitHub|S3|Personal|Ana|Work|[A-Z]|[\d,.\s]+ sats|localhost:3400|[\d\s.,:·+↻…✓-]*|v?\d+\.\d+\.\d+.*|(?:[\d.,]+ (?:ms|s|min|h|bytes|KB|MB|kbit\/s) ?)+)$/;

/**
 * What a person sees or hears: text, and the labels screen readers and tooltips read out. Text marked
 * `translate="no"` is data (an id, a cipher suite, an engine state), the same in every language.
 */
function visibleStrings(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!node.parentElement?.closest('[translate="no"]')) out.push(node.nodeValue ?? "");
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
  // An error the app throws in English ("Choose a picture"), said in the page's language (lib/errorText.ts).
  { name: "Profile, a file that is not a picture chosen for it", render: () => <Profile />, open: async () => {
    fireEvent.change(screen.getByTestId("profile-avatar-input"), { target: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] } });
    await screen.findByRole("alert");
  } },
  { name: "Profile, S3 storage open", render: () => <Profile />, open: async (user) => { await user.click(screen.getByTestId("s3-setup")); } },
  { name: "Profile on a host with profiles, a new one being named", render: () => <Profile />, open: async (user) => { await user.click(screen.getByTestId("profile-new")); } },
  { name: "Deleting a profile", render: () => <DeleteProfileDialog entry={{ id: "work", name: "Work", createdAt: 0 }} onClose={() => {}} /> },
  { name: "Services, where sharing needs another app", render: () => <Services /> },
  { name: "Services, sharing a local app", share: true, render: () => <Services />, open: async (user) => { await user.click(await screen.findByTestId("add-service")); } },
  { name: "Home", render: () => <Home /> },
  { name: "the chat list's search with nothing found", render: () => <UpdateProvider><Sidebar /></UpdateProvider>, open: async (user) => { await user.type(screen.getByRole("textbox"), "zzzz"); } },
  { name: "a file's details, sent live and confirmed", render: () => details(FILE_SENT), open: detailsLoaded },
  { name: "a payment request's details, on the DHT floor", render: () => details(REQUEST_ON_DHT), open: detailsLoaded },
];

/** A message's details panel (WISP 400 § Message details) for `view`: the engine's answer, as `messageDetails` gives it. */
function details(view: MessageDetailsView) {
  fakeEngine.on("messageDetails", () => view);
  const { message } = view;
  return <MessageDetailsPanel linkId="link-1" onClose={() => {}} message={{
    id: message.id, text: "42", sender: "me", timestamp: message.timestamp, delivery: message.delivery,
    ...(view.file && { file: { id: view.file.id, name: view.file.name, size: view.file.size, mime: view.file.mime } }),
    ...(view.payment && { paymentId: view.payment.id }),
  }} />;
}
async function detailsLoaded() { await waitFor(() => expect(screen.getByTestId("message-details")).toHaveAttribute("data-loaded", "yes")); }

const LINK: MessageDetailsView["link"] = { id: "link-1", profile: "paired-chat/1", myKey: "k".repeat(52), peerKey: "p".repeat(52), verified: false, transportNow: "iroh/1", relayedNow: true, rttNowMs: 80 };
const FILE_SENT: MessageDetailsView = {
  message: { id: "me_f", wireId: "wireidwireidwireidwire", linkId: "link-1", sender: "me", timestamp: 1_700_000_000_000, via: "datalink", delivery: "delivered", kind: "file", textBytes: 10 },
  details: {
    sends: [{ at: 1_700_000_000_100, path: "webrtc/1", relayed: false, rttMs: 12, result: "failed", error: "closed" }, { at: 1_700_000_001_100, path: "webrtc/1", relayed: false, rttMs: 12, result: "sent" }],
    attempts: 2, sentAt: 1_700_000_001_100, receiptAt: 1_700_000_005_000, completedAt: 1_700_000_005_000,
    wire: { frame: "pf-offer + pf-data", protocol: "files/3", plaintextBytes: 3_000_000, chunks: 184, chunkBytes: 16_384 },
  },
  link: LINK,
  file: { id: "f1", name: "2023-11-14 12.00.00", size: 3_000_000, mime: "application/octet-stream", digest: "ab".repeat(32), protocol: "files/3", state: "done", confirmed: 3_000_000, since: 1_700_000_000_100, consented: true, storage: "opfs" },
};
const REQUEST_ON_DHT: MessageDetailsView = {
  message: { id: "me_p", wireId: "wireidwireidwireidwire", linkId: "link-1", sender: "me", timestamp: 1_700_000_000_000, via: "pkarr", delivery: "sent", kind: "payment", textBytes: 20 },
  details: {
    sends: [{ at: 1_700_000_000_100, path: "dht", result: "sent" }], attempts: 1, sentAt: 1_700_000_000_100,
    wire: { frame: "_dm envelope", protocol: "dht-text/1", plaintextBytes: 20, wireBytes: 412 },
    dht: { seq: 7, issued: 1_700_000_000_100, expires: 1_700_000_300_100, packetBytes: 412, nonce: "n".repeat(32), recordKey: "k".repeat(52), records: ["_dm", "_dmk"] },
    hold: { seq: 3, bytes: 180, expires: 1_700_604_800_000 },
  },
  link: { ...LINK, peerKey: undefined, transportNow: undefined },
  payment: { id: "pay-1", kind: "request", direction: "out", amount: 2100, unit: "sat", state: "pending", method: "lightning", network: "lightning", provider: "cashu-mint", mint: "https://mint.example", createdAt: 1_700_000_000_000, invoiceDigest: "ef".repeat(32) },
};

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

import { act, screen } from "@testing-library/react";
import { useRef, useState, type ReactElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { ChatSearchBar } from "../../components/chat/ChatSearch";
import { FolderNameDialog } from "../../components/chat/ChatFolderDialogs";
import { ChatTargetSearch } from "../../components/chat/ChatTargets";
import { PanelSearch } from "../../components/composer/PanelParts";
import { RenameDeviceDialog } from "../../components/devices/RenameDeviceDialog";
import { GroupMembersDialog } from "../../components/GroupMembersDialog";
import { NameStep } from "../../components/NameStep";
import { NewGroupDialog } from "../../components/NewGroupDialog";
import { NostrSection } from "../../components/nostr/NostrSection";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import type { ChatSearch } from "../../hooks/useChatSearch";
import type { Language } from "../../lib/settings";
import { NAME_STEP_TEST_KEY, askNameIn, setNameStepUnderTest } from "../../lib/nameStep";
import { setRunningProfile } from "../../lib/profiles";
import { Profile } from "../../pages/Profile";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.i18n

/*
 * A field where a person types a name, the words to look for or a Nostr note or About reads what is typed from its first letter, as the message
 * field does: "Bob!" in the Arabic app, not "!Bob"; an Arabic name ending in "؟" in the English app, its mark at its
 * end. Empty, it keeps the app's direction, its placeholder with it.
 */

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const ME = "me".padEnd(52, "y");
const admin = () => groupView({ status: "active", epoch: 2, isAdmin: true, name: "Friends", members: [{ key: ME, role: "admin", me: true, online: true, missing: 0 }] });

/** The in-chat search bar with the state its hook would keep. */
function SearchBar() {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const search = { open: true, query, term: query, results: [], index: -1, inputRef, setQuery, dismiss() {}, older() {}, newer() {} };
  return <ChatSearchBar search={search as unknown as ChatSearch} />;
}

function ForwardSearch() {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null), list = useRef<HTMLElement>(null);
  return <ChatTargetSearch inputRef={inputRef} list={list} value={value} onChange={setValue} testId="forward-search" />;
}

function EmojiSearch() {
  const [value, setValue] = useState("");
  return <PanelSearch value={value} onChange={setValue} placeholder="Search" />;
}

/** Identities → Nostr with one proved key, publication on, and its note or profile form open. */
async function nostrForm(button: "nostr-post" | "nostr-profile-edit", testId: string) {
  act(() => fakeEngine.update({ nostr: { own: [{ subject: "npub1me", npub: "npub1".padEnd(63, "q") }], settings: { relays: [], autoLoadProfiles: false, publish: true } } }));
  screen.getByTestId(button).click();
  return screen.findByTestId(testId);
}

const FIELDS: { name: string; ui: () => ReactElement; field: () => Promise<HTMLElement> }[] = [
  { name: "the profile's name", ui: () => <Profile />, field: async () => screen.getByTestId("profile-name") },
  { name: "the name in chats", ui: () => <Profile />, field: async () => screen.getByTestId("account-nickname") },
  { name: "the name step", ui: () => <NameStep />, field: () => screen.findByTestId("name-step-input") },
  { name: "a new group's name", ui: () => <NewGroupDialog onClose={() => {}} onCreated={() => {}} />, field: async () => screen.getByTestId("new-group-name") },
  { name: "a group's rename", ui: () => <GroupMembersDialog group={admin()} onClose={() => {}} />, field: async () => { screen.getByTestId("group-rename").click(); return screen.findByTestId("group-rename-input"); } },
  { name: "a device's rename", ui: () => <RenameDeviceDialog device="Phone" deviceKey="device-key" onClose={() => {}} />, field: async () => screen.getByTestId("device-rename-name") },
  { name: "a folder's name", ui: () => <FolderNameDialog onClose={() => {}} onSave={() => {}} />, field: async () => screen.getByTestId("folder-name") },
  { name: "the chat list's search", ui: () => <UpdateProvider><Sidebar /></UpdateProvider>, field: async () => screen.getByRole("searchbox") },
  { name: "the in-chat search", ui: () => <SearchBar />, field: async () => screen.getByTestId("chat-search-input") },
  { name: "Forward's search", ui: () => <ForwardSearch />, field: async () => screen.getByTestId("forward-search") },
  { name: "the emoji panel's search", ui: () => <EmojiSearch />, field: async () => screen.getByTestId("expression-search") },
  { name: "a Nostr note", ui: () => <NostrSection />, field: () => nostrForm("nostr-post", "nostr-post-text") },
  { name: "a Nostr profile's About", ui: () => <NostrSection />, field: () => nostrForm("nostr-profile-edit", "nostr-profile-about") },
];

const TYPED: { language: Language; text: string }[] = [
  { language: "ar", text: "Bob!" },
  { language: "en", text: "أصدقاء؟" },
];

beforeEach(() => {
  localStorage.clear();
  setRunningProfile(undefined);
  setNameStepUnderTest(() => false);
  localStorage.setItem(NAME_STEP_TEST_KEY, "on");
  askNameIn("");
  fakeEngine.update({ groups: [admin()] });
});

describe("a name or search field lays out what is typed in its own direction", () => {
  for (const { name, ui, field } of FIELDS) {
    for (const { language, text } of TYPED) {
      it(`${name}: "${text}" in the ${language} app, the app's direction while empty`, async () => {
        const { user } = renderApp(ui(), { language });
        const input = await field();
        await user.clear(input);
        expect(input).not.toHaveAttribute("dir");
        await user.type(input, text);
        expect(input).toHaveValue(text);
        expect(input).toHaveAttribute("dir", "auto");
      });
    }
  }
});

import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAppPanel, ChatAppResume } from "../../components/apps/ChatAppPanel";
import { chatApp } from "../../lib/apps/running";
import { webOpener } from "../../lib/apps/webOpener";
import type { AppEntry, AppsPlatform } from "../../lib/platform";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: apps.view

// On a phone: Notes runs in the chat and the person went Back from it. They press Open on Chess's card (slow: its
// files download), then tap "Back to Notes" and use it. Chess finishing later must not stop Notes and take its place.
vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));
const started: string[] = [];
const stopped: string[] = [];
vi.mock("../../lib/apps/broker", async (actual) => ({
  ...(await actual<typeof import("../../lib/apps/broker")>()),
  startApp: ({ container, launch, onStop }: { container: HTMLElement; launch: { title: string }; onStop?: (reason: string) => void }) => {
    const frame = document.createElement("iframe");
    frame.title = launch.title;
    container.appendChild(frame);
    started.push(launch.title);
    let done = false;
    const stop = () => { if (done) return; done = true; frame.remove(); stopped.push(launch.title); onStop?.("stopped"); };
    return { frame, phase: "running", stop };
  },
}));

const LINK = "link-1";
const CHESS = "pubkeyalpha/chess";
const NOTES = "pubkeyalpha/notes";
const entries: Record<string, AppEntry> = {
  [CHESS]: { ref: CHESS, digest: "c", version: "1.0.0", title: "Chess", permissions: ["chat"], entry: "<p>chess</p>" },
  [NOTES]: { ref: NOTES, digest: "n", version: "1.0.0", title: "Notes", permissions: ["chat"], entry: "<p>notes</p>" },
};

let release!: () => void;
let chessFiles: Promise<void>;
const host = {
  runnerUrl: "/app-frame.html",
  entry: async (ref: string) => { if (ref === CHESS) await chessFiles; return entries[ref]!; },
} as unknown as AppsPlatform;

beforeEach(() => {
  started.length = 0;
  stopped.length = 0;
  chessFiles = new Promise<void>((resolve) => { release = resolve; });
});

describe("Back to <app> while another app opens in the chat (web)", () => {
  it("the app the person went back to stays when the other app's Open finishes later; that one starts nothing", async () => {
    windowIs(true);
    const { user } = renderApp(<div className="chat-pane"><div className="chat-column"><ChatAppResume linkId={LINK} /><textarea aria-label="Message" /></div>
      <ChatAppPanel linkId={LINK} sessionId="s1" contact={{ name: "Ana", named: true }} peerKey="peer" /></div>);
    act(() => fakeEngine.update({ links: [linkView({ id: LINK, peerPubKeyZ32: "peer", profile: "paired-chat/1" })] }));
    const open = webOpener({ apps: () => host, nameIn: () => undefined, closeLabel: () => "Close" });

    await act(() => open(NOTES, LINK));
    const app = screen.getByTestId("mini-app");
    await user.click(within(app).getByTestId("mini-app-back"));
    let late!: Promise<void | "shown" | "superseded">;
    act(() => { late = open(CHESS, LINK); });
    await user.click(screen.getByTestId("mini-app-resume"));
    expect(app).toBeVisible();

    release();
    let result: void | "shown" | "superseded" = undefined;
    await act(async () => { result = await late; });
    // Nothing new started: Notes was not stopped, and the contact is not told Chess opened.
    expect(started).toEqual(["Notes"]);
    expect(stopped).toEqual([]);
    expect(result).toBe("superseded");
    await waitFor(() => expect(chatApp(LINK)?.ref).toBe(NOTES));
    expect(chatApp(LINK)?.shown).toBe(true);
    expect(within(app).getByTitle("Notes")).toBeInTheDocument();
  });
});

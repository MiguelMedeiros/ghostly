import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { ChatAppPanel, ChatAppResume } from "../../components/apps/ChatAppPanel";
import { setAppOpener, takedownText, type AppOpener } from "../../lib/apps/open";
import { appErrorText } from "../../lib/apps/errors";
import { LOCALES as locales } from "../i18n/locales";
import { translateWith } from "../../locales/translate";
import { chatApp } from "../../lib/apps/running";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { webOpener } from "../../lib/apps/webOpener";
import type { AppsPlatform } from "../../lib/platform";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: apps.takedown

// A version found revoked or removed while it runs (WISP 1200 § Takedowns): the page stops it and says why.
vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));
const started: { frame: HTMLIFrameElement; stop: Mock<(reason?: string) => void> }[] = [];
vi.mock("../../lib/apps/broker", async (actual) => ({
  ...(await actual<typeof import("../../lib/apps/broker")>()),
  startApp: ({ container, launch, onStop }: { container: HTMLElement; launch: { title: string }; onStop?: (reason: string) => void }) => {
    const frame = document.createElement("iframe");
    frame.title = launch.title;
    container.appendChild(frame);
    let done = false;
    // `stop(reason)` here stands for the broker's own stops too: the frame navigated, broke the protocol, never started.
    const stop = vi.fn((reason = "stopped") => { if (done) return; done = true; frame.remove(); onStop?.(reason); });
    started.push({ frame, stop });
    return { frame, phase: "running", stop };
  },
}));

const REF = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo/chess";
/** What the next open's entry waits for: an open that fails (offline) or that is held to look at it meanwhile. */
let entryWaits: Promise<void> | null = null;
/** What each open asked the engine: Run anyway or not. */
const anyway: boolean[] = [];
const host = {
  runnerUrl: "/app-frame.html",
  entry: async (_ref: string, runAnyway: boolean) => {
    anyway.push(runAnyway);
    if (entryWaits) await entryWaits;
    return { ref: REF, digest: "d", version: "1.2.0", title: "Chess", permissions: ["chat"], entry: "<!doctype html>" };
  },
} as unknown as AppsPlatform;

let run: InstalledAppView["run"] = { status: "ok" };
const installed = (): InstalledAppView => ({
  ref: REF, name: "chess", publisher: REF.split("/")[0]!, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess", version: "1.2.0",
  sequence: 7, digest: "d", permissions: ["chat"], view: "chat", from: "https://raw.githubusercontent.com/a/chess/HEAD/app.ghostlyapp", icon: false, installedAt: 1, updatedAt: 1,
  run, listedBy: [], unknownPublisher: false,
});

let open: AppOpener;
beforeEach(() => {
  started.length = 0;
  anyway.length = 0;
  entryWaits = null;
  run = { status: "ok" };
  forgetInstalledApps();
  fakeEngine.on("appList", () => [installed()]);
  open = webOpener({ apps: () => host, nameIn: () => undefined, closeLabel: () => "Close", stoppedLabel: (title, takedown) => takedownText(title, takedown, translateWith(locales.en, "en")) });
});
afterEach(() => {
  document.querySelectorAll("[data-place=alone]").forEach((node) => node.remove());
});

function chatPanel(phone = false) {
  windowIs(phone);
  const view = renderApp(<div className="chat-pane"><div className="chat-column"><ChatAppResume linkId="link-1" /><textarea aria-label="Message" /></div>
    <ChatAppPanel linkId="link-1" sessionId="s1" contact={{ name: "Ana", named: true }} peerKey="peer" /></div>);
  act(() => fakeEngine.update({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer", profile: "paired-chat/1" })] }));
  return view;
}

/** The engine's update check ran (the scheduled one, no page asked) and found `next`. */
async function checked(next: InstalledAppView["run"]) {
  run = next;
  await act(async () => { fakeEngine.emit({ kind: "apps-checked" }); await new Promise((r) => setTimeout(r, 10)); });
}

describe("an app running when its version is taken down", () => {
  it("in a chat: revoked stops it, and the panel says why until it is closed", async () => {
    const { user } = chatPanel();
    await act(() => open(REF, "link-1"));
    await checked({ status: "revoked" });
    expect(started[0]!.stop).toHaveBeenCalled();
    const app = screen.getByTestId("mini-app");
    expect(app).toBeVisible();
    expect(within(app).getByTestId("mini-app-stopped")).toHaveTextContent("Chess was stopped: its publisher revoked this version");
    expect(within(app).queryByRole("iframe")).not.toBeInTheDocument();
    expect(started[0]!.frame.isConnected).toBe(false);
    await user.click(within(app).getByRole("button", { name: "Close" }));
    expect(app).not.toBeVisible();
    expect(chatApp("link-1")).toBeUndefined();
  });

  it("in a chat: removed by a store stops it, unless the person chose Run anyway", async () => {
    chatPanel();
    await act(() => open(REF, "link-1", { runAnyway: true }));
    const removed: InstalledAppView["run"] = { status: "removed", by: [{ store: "k", name: "Ghostly", reason: "Malware", at: 1 }] };
    await checked(removed);
    expect(started[0]!.stop).not.toHaveBeenCalled();
    act(() => chatApp("link-1")!.running.stop());

    await act(() => open(REF, "link-1"));
    await checked(removed);
    expect(started[1]!.stop).toHaveBeenCalled();
    expect(screen.getByTestId("mini-app-stopped")).toHaveTextContent("Chess was stopped: Ghostly removed this version");
  });

  it("a version still fine keeps running", async () => {
    chatPanel();
    await act(() => open(REF, "link-1"));
    await checked({ status: "ok" });
    expect(started[0]!.stop).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mini-app-stopped")).not.toBeInTheDocument();
  });

  it("uninstalled while it runs, in a chat and alone: it is stopped and its place goes, with no notice", async () => {
    chatPanel();
    await act(() => open(REF, "link-1"));
    await open(REF, null);
    // The person uninstalled it (on this page or another): the engine says so as it does after a check.
    fakeEngine.on("appList", () => []);
    await checked({ status: "ok" });
    expect(started[0]!.stop).toHaveBeenCalled();
    expect(started[1]!.stop).toHaveBeenCalled();
    expect(chatApp("link-1")).toBeUndefined();
    expect(screen.queryByTestId("mini-app-stopped")).not.toBeInTheDocument();
    expect(document.querySelector("[data-place=alone]")).toBeNull();
  });

  it("after an update came while it ran: the version it runs is the one judged, not the one installed", async () => {
    chatPanel();
    await act(() => open(REF, "link-1"));
    // The check installed a newer version, fine to run, and found the one that still runs here revoked.
    const updated = (stopped: InstalledAppView["stopped"]) => fakeEngine.on("appList", () => [{ ...installed(), sequence: 8, digest: "d2", ...(stopped && { stopped }) }]);
    updated(undefined);
    await checked({ status: "ok" });
    expect(started[0]!.stop).not.toHaveBeenCalled();
    updated([{ digest: "other", run: { status: "revoked" } }]);
    await checked({ status: "ok" });
    expect(started[0]!.stop).not.toHaveBeenCalled();
    updated([{ digest: "d", run: { status: "revoked" } }]);
    await checked({ status: "ok" });
    expect(started[0]!.stop).toHaveBeenCalled();
    expect(screen.getByTestId("mini-app-stopped")).toHaveTextContent("Chess was stopped: its publisher revoked this version");
  });

  it("alone: stops it and says why in its place", async () => {
    await open(REF, null);
    await checked({ status: "revoked" });
    expect(started[0]!.stop).toHaveBeenCalled();
    const app = await waitFor(() => screen.getByTestId("mini-app"));
    expect(within(app).getByTestId("mini-app-stopped")).toHaveTextContent("Chess was stopped: its publisher revoked this version");
    within(app).getByRole("button", { name: "Close" }).click();
    expect(screen.queryByTestId("mini-app")).not.toBeInTheDocument();
  });
});

// The runner (WISP 1200 § the runner, step 7): an app whose frame loads again is torn down, and its place says it stopped.
describe("an app that stops on its own", () => {
  const STOPPED = "Chess stopped working and was closed. If it keeps happening, tell its publisher.";
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });

  it("in a chat: the panel stays, shown, and says it stopped until it is closed", async () => {
    const { user } = chatPanel();
    await act(() => open(REF, "link-1"));
    act(() => started[0]!.stop("navigated"));
    const app = screen.getByTestId("mini-app");
    expect(app).toBeVisible();
    expect(within(app).getByRole("status")).toHaveTextContent(STOPPED);
    expect(started[0]!.frame.isConnected).toBe(false);
    await user.click(within(app).getByRole("button", { name: "Close" }));
    expect(app).not.toBeVisible();
    expect(chatApp("link-1")).toBeUndefined();
  });

  it("alone: its layer stays, says it stopped, keeps the focus, and goes with Close", async () => {
    for (const reason of ["navigated", "protocol", "timeout"]) {
      await open(REF, null);
      const last = started[started.length - 1]!;
      last.frame.focus();
      last.stop(reason);
      const app = screen.getByTestId("mini-app");
      expect(within(app).getByRole("status"), reason).toHaveTextContent(STOPPED);
      const close = within(app).getByRole("button", { name: "Close" });
      expect(app.contains(document.activeElement), reason).toBe(true);
      close.click();
      expect(screen.queryByTestId("mini-app"), reason).not.toBeInTheDocument();
    }
  });

  it("one that asked to close, or that the person stopped, goes with no notice", async () => {
    chatPanel();
    await act(() => open(REF, "link-1"));
    act(() => started[0]!.stop("closed"));
    expect(chatApp("link-1")).toBeUndefined();
    await open(REF, null);
    started[1]!.stop("closed");
    await open(REF, null);
    started[2]!.stop();
    expect(document.querySelector("[data-place=alone]")).toBeNull();
    expect(screen.queryByTestId("mini-app-stopped")).toBeNull();
  });
});

// The watchdog (WISP 1200 § The runner and the broker): an app that held its thread past the bound was stopped by the
// page. Its place says so, and it may be opened again.
describe("an app the watchdog stopped", () => {
  const UNRESPONSIVE = "Chess stopped responding and was closed, so your chats keep working. Open it again, or tell its publisher if it keeps happening.";
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { setAppOpener(null); });

  it("in a chat: the panel says it stopped responding, and Open again starts it in the same panel", async () => {
    setAppOpener(open);
    const { user } = chatPanel();
    await act(() => open(REF, "link-1"));
    act(() => started[0]!.stop("unresponsive"));
    const app = screen.getByTestId("mini-app");
    expect(within(app).getByRole("status")).toHaveTextContent(UNRESPONSIVE);
    await user.click(within(app).getByRole("button", { name: "Open again" }));
    await waitFor(() => expect(started).toHaveLength(2));
    expect(within(app).queryByRole("status")).not.toBeInTheDocument();
    expect(within(app).queryByRole("button", { name: "Open again" })).not.toBeInTheDocument();
    expect(app).toContainElement(started[1]!.frame);
    expect(chatApp("link-1")?.stopped).toBeUndefined();
    // Its button went with the stopped message: the focus is in the panel, not on the page.
    await waitFor(() => expect(app.contains(document.activeElement)).toBe(true));
  });

  it("in a chat: one a store removed, run anyway, opens again as it was run, and a removed check leaves it running", async () => {
    setAppOpener(open);
    const { user } = chatPanel();
    const removed: InstalledAppView["run"] = { status: "removed", by: [{ store: "k", name: "Ghostly", reason: "Malware", at: 1 }] };
    run = removed;
    await act(() => open(REF, "link-1", { runAnyway: true }));
    act(() => started[0]!.stop("unresponsive"));
    const app = screen.getByTestId("mini-app");
    await user.click(within(app).getByRole("button", { name: "Open again" }));
    await waitFor(() => expect(started).toHaveLength(2));
    expect(anyway).toEqual([true, true]);
    await checked(removed);
    expect(started[1]!.stop).not.toHaveBeenCalled();
    expect(within(app).queryByTestId("mini-app-stopped")).not.toBeInTheDocument();
  });

  it("in a chat: Open again that fails says why under it, in the person's language, and the panel stays", async () => {
    setAppOpener(open);
    const { user } = chatPanel();
    await act(() => open(REF, "link-1"));
    act(() => started[0]!.stop("unresponsive"));
    const app = screen.getByTestId("mini-app");
    let fail!: (error: Error) => void;
    entryWaits = new Promise((_, reject) => { fail = reject; });
    const again = within(app).getByRole("button", { name: "Open again" });
    await user.click(again);
    // Busy while it opens: a second press starts nothing more.
    const busy = again.getAttribute("aria-busy");
    await user.click(again);
    await act(async () => { fail(new Error("offline: the runner page could not be reached")); await new Promise((r) => setTimeout(r, 10)); });
    expect(within(app).queryByRole("alert")).toHaveTextContent("You are offline.");
    expect(app).toBeVisible();
    expect(within(app).getByRole("status")).toHaveTextContent(UNRESPONSIVE);
    expect(busy).toBe("true");
    expect(again).not.toHaveAttribute("aria-busy");
    expect(app.contains(document.activeElement)).toBe(true);
    expect(started).toHaveLength(1);
    // Pressed again and it works: the line goes with the stopped message.
    entryWaits = null;
    await user.click(within(app).getByRole("button", { name: "Open again" }));
    await waitFor(() => expect(started).toHaveLength(2));
    expect(within(app).queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([["Close", false], ["Back to the chat", true]])("in a chat: left with %s while Open again opens, it stays closed", async (leave, phone) => {
    setAppOpener(open);
    const { user } = chatPanel(phone);
    await act(() => open(REF, "link-1"));
    act(() => started[0]!.stop("unresponsive"));
    const app = screen.getByTestId("mini-app");
    let go!: () => void;
    entryWaits = new Promise((resolve) => { go = resolve; });
    await user.click(within(app).getByRole("button", { name: "Open again" }));
    await user.click(within(app).getByRole("button", { name: leave }));
    expect(chatApp("link-1")).toBeUndefined();
    await act(async () => { go(); await new Promise((r) => setTimeout(r, 10)); });
    expect(started).toHaveLength(1);
    expect(chatApp("link-1")).toBeUndefined();
    expect(app).not.toBeVisible();
  });

  const en = translateWith(locales.en, "en");
  const aloneOpener = () => webOpener({ apps: () => host, nameIn: () => undefined, closeLabel: () => "Close", openAgainLabel: () => "Open again", errorText: (error) => appErrorText(error, en), stoppedLabel: (title, takedown) => takedownText(title, takedown, en) });

  it("alone: Open again that fails keeps the layer and says why there", async () => {
    open = aloneOpener();
    await open(REF, null);
    started[0]!.stop("unresponsive");
    const app = screen.getByTestId("mini-app");
    let fail!: (error: Error) => void;
    entryWaits = new Promise((_, reject) => { fail = reject; });
    const again = within(app).getByRole("button", { name: "Open again" });
    again.click();
    const busy = again.getAttribute("aria-busy");
    fail(new Error("offline: the runner page could not be reached"));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(app).toBeInTheDocument();
    expect(within(app).queryByRole("alert")).toHaveTextContent("You are offline.");
    expect(within(app).getByRole("status")).toHaveTextContent(UNRESPONSIVE);
    expect(busy).toBe("true");
    expect(again).not.toHaveAttribute("aria-busy");
    expect(started).toHaveLength(1);
    // It works the next time: one layer, the app in it.
    entryWaits = null;
    again.click();
    await waitFor(() => expect(started).toHaveLength(2));
    expect(document.querySelectorAll("[data-place=alone]")).toHaveLength(1);
    expect(screen.getByTestId("mini-app")).toContainElement(started[1]!.frame);
  });

  it("alone: its layer says it stopped responding, and Open again opens it again", async () => {
    open = aloneOpener();
    await open(REF, null);
    started[0]!.stop("unresponsive");
    const app = screen.getByTestId("mini-app");
    expect(within(app).getByRole("status")).toHaveTextContent(UNRESPONSIVE);
    within(app).getByRole("button", { name: "Open again" }).click();
    await waitFor(() => expect(started).toHaveLength(2));
    expect(document.querySelectorAll("[data-place=alone]")).toHaveLength(1);
    expect(screen.getByTestId("mini-app")).toContainElement(started[1]!.frame);
    expect(screen.queryByTestId("mini-app-stopped")).not.toBeInTheDocument();
  });

  it("an app stopped for anything else offers no Open again", async () => {
    setAppOpener(open);
    chatPanel();
    await act(() => open(REF, "link-1"));
    act(() => started[0]!.stop("protocol"));
    expect(screen.queryByRole("button", { name: "Open again" })).not.toBeInTheDocument();
  });
});

// An app that kept taking the keyboard by script was stopped by the page (`holdFocus`): its place says why in one line.
describe("an app stopped for taking the keyboard", () => {
  const FOCUS = "Chess was stopped: it kept taking the keyboard";
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { setAppOpener(null); });

  it("in a chat: the panel says why, offers no Open again, and the message field keeps the focus", async () => {
    setAppOpener(open);
    chatPanel();
    await act(() => open(REF, "link-1"));
    const field = screen.getByRole("textbox", { name: "Message" });
    act(() => field.focus());
    act(() => started[0]!.stop("focus"));
    const app = screen.getByTestId("mini-app");
    expect(within(app).getByRole("status")).toHaveTextContent(FOCUS);
    expect(within(app).queryByRole("button", { name: "Open again" })).not.toBeInTheDocument();
    expect(chatApp("link-1")?.stopped).toEqual({ why: "focus" });
    expect(document.activeElement).toBe(field);
  });

  it("alone: its layer says why, with no Open again", async () => {
    const en = translateWith(locales.en, "en");
    open = webOpener({ apps: () => host, nameIn: () => undefined, closeLabel: () => "Close", openAgainLabel: () => "Open again", stoppedLabel: (title, takedown) => takedownText(title, takedown, en) });
    await open(REF, null);
    started[0]!.stop("focus");
    const app = screen.getByTestId("mini-app");
    expect(within(app).getByRole("status")).toHaveTextContent(FOCUS);
    expect(within(app).queryByRole("button", { name: "Open again" })).not.toBeInTheDocument();
  });

  it("has its line in every language", () => {
    const lines = (Object.keys(locales) as (keyof typeof locales)[]).map((lang) => takedownText("Chess", { why: "focus" }, translateWith(locales[lang], lang)));
    for (const line of lines) expect(line).toContain("Chess");
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines).toContain(FOCUS);
  });
});

// The focus was in the app's frame, gone with it: it stays in the panel, as it does in the layer of an app alone, so
// the stopped message and Open again are reached by keyboard and Escape still closes.
describe("an app in a chat that stops while the focus is in it", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); setAppOpener(open); });
  afterEach(() => { setAppOpener(null); });

  for (const phone of [false, true]) {
    const where = phone ? "on a phone" : "beside the chat";
    for (const reason of ["unresponsive", "protocol", "navigated", "revoked"]) {
      it(`${where}, ${reason}: the focus goes into the panel, and Escape closes it`, async () => {
        const { user } = chatPanel(phone);
        await act(() => open(REF, "link-1"));
        const app = screen.getByTestId("mini-app");
        act(() => started[0]!.frame.focus());
        expect(document.activeElement).toBe(started[0]!.frame);
        if (reason === "revoked") await checked({ status: "revoked" });
        else act(() => started[0]!.stop(reason));
        expect(within(app).getByTestId("mini-app-stopped")).toBeVisible();
        expect(app.contains(document.activeElement)).toBe(true);
        // Open again when the watchdog stopped it, else Back on a phone, else the panel.
        expect(document.activeElement).toBe(reason === "unresponsive" ? within(app).getByRole("button", { name: "Open again" })
          : phone ? within(app).getByTestId("mini-app-back") : app);
        await user.keyboard("{Escape}");
        expect(app).not.toBeVisible();
        expect(chatApp("link-1")).toBeUndefined();
      });
    }
  }

  it("never taken from where the person went meanwhile", async () => {
    chatPanel();
    await act(() => open(REF, "link-1"));
    const field = screen.getByRole("textbox", { name: "Message" });
    act(() => field.focus());
    act(() => started[0]!.stop("unresponsive"));
    expect(screen.getByTestId("mini-app-stopped")).toBeVisible();
    expect(document.activeElement).toBe(field);
  });
});

// On a phone the person went Back to the chat and types there: an app that stops meanwhile stays behind Back. Its way
// back says it stopped, and the panel says why once the person goes back to it.
describe("an app in a chat the person went Back from, that stops", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); setAppOpener(open); });
  afterEach(() => { setAppOpener(null); });

  for (const reason of ["revoked", "unresponsive", "navigated"]) {
    it(`${reason}: the chat keeps the focus and stays in reach, and the way back says it stopped`, async () => {
      const { user } = chatPanel(true);
      await act(() => open(REF, "link-1"));
      const app = screen.getByTestId("mini-app");
      await user.click(within(app).getByTestId("mini-app-back"));
      const field = screen.getByRole("textbox", { name: "Message" });
      await user.click(field);
      await user.keyboard("Hi");
      if (reason === "revoked") await checked({ status: "revoked" });
      else act(() => started[0]!.stop(reason));
      expect(app).not.toBeVisible();
      expect(document.activeElement).toBe(field);
      expect(document.querySelector(".chat-column")).not.toHaveAttribute("inert");
      await user.keyboard(" Ana");
      expect(field).toHaveValue("Hi Ana");
      const resume = screen.getByTestId("mini-app-resume");
      expect(within(resume).getByTestId("mini-app-resume-stopped")).toHaveTextContent("Stopped");

      await user.click(resume);
      expect(app).toBeVisible();
      expect(within(app).getByTestId("mini-app-stopped")).toBeVisible();
      await user.click(within(app).getByRole("button", { name: "Close" }));
      expect(chatApp("link-1")).toBeUndefined();
      expect(screen.queryByTestId("mini-app-resume")).not.toBeInTheDocument();
    });
  }
});

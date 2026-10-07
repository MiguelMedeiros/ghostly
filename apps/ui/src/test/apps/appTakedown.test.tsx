import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { ChatAppPanel } from "../../components/apps/ChatAppPanel";
import { takedownText, type AppOpener } from "../../lib/apps/open";
import { locales } from "../../locales";
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
const started: { frame: HTMLIFrameElement; stop: ReturnType<typeof vi.fn> }[] = [];
vi.mock("../../lib/apps/broker", async (actual) => ({
  ...(await actual<typeof import("../../lib/apps/broker")>()),
  startApp: ({ container, launch, onStop }: { container: HTMLElement; launch: { title: string }; onStop?: (reason: string) => void }) => {
    const frame = document.createElement("iframe");
    frame.title = launch.title;
    container.appendChild(frame);
    let done = false;
    const stop = vi.fn(() => { if (done) return; done = true; frame.remove(); onStop?.("stopped"); });
    started.push({ frame, stop });
    return { frame, phase: "running", stop };
  },
}));

const REF = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo/chess";
const host = {
  runnerUrl: "/app-frame.html",
  entry: async () => ({ ref: REF, version: "1.2.0", title: "Chess", permissions: ["chat"], entry: "<!doctype html>" }),
} as unknown as AppsPlatform;

let run: InstalledAppView["run"] = { status: "ok" };
const installed = (): InstalledAppView => ({
  ref: REF, name: "chess", publisher: REF.split("/")[0]!, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess", version: "1.2.0",
  sequence: 7, digest: "d", permissions: ["chat"], from: "https://raw.githubusercontent.com/a/chess/HEAD/app.ghostlyapp", icon: false, installedAt: 1, updatedAt: 1,
  run, listedBy: [], unknownPublisher: false,
});

let open: AppOpener;
beforeEach(() => {
  started.length = 0;
  run = { status: "ok" };
  forgetInstalledApps();
  fakeEngine.on("appList", () => [installed()]);
  open = webOpener({ apps: () => host, closeLabel: () => "Close", stoppedLabel: (title, takedown) => takedownText(title, takedown, translateWith(locales.en, "en")) });
});
afterEach(() => {
  document.querySelectorAll("[data-place=alone]").forEach((node) => node.remove());
});

function chatPanel() {
  windowIs(false);
  const view = renderApp(<div className="chat-pane"><div className="chat-column" />
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
    expect(within(app).getByTestId("mini-app-stopped")).toHaveTextContent("Chess was stopped: its maker revoked this version");
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

  it("alone: stops it and says why in its place", async () => {
    await open(REF, null);
    await checked({ status: "revoked" });
    expect(started[0]!.stop).toHaveBeenCalled();
    const app = await waitFor(() => screen.getByTestId("mini-app"));
    expect(within(app).getByTestId("mini-app-stopped")).toHaveTextContent("Chess was stopped: its maker revoked this version");
    within(app).getByRole("button", { name: "Close" }).click();
    expect(screen.queryByTestId("mini-app")).not.toBeInTheDocument();
  });
});

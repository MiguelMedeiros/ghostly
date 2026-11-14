import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readStatusCard, type TaskCard } from "@ghostly/core";
import { BackupProgress } from "../../components/BackupProgress";
import { FileBubble } from "../../components/FileBubble";
import { ProgressBar } from "../../components/chat/StatusCard";
import { BoardCard } from "../../components/tasks/BoardCard";
import { servicesPlatform } from "../../lib/platform";
import type { BoardTask } from "../../lib/taskBoard";
import { fakeEngine, linkView } from "../fakeEngine";
import { everythingOnScreen } from "../onScreen";
import { renderApp } from "../render";

// covers: app.accessibility, app.theme

/**
 * Forced colors (Windows Contrast themes) replace backgrounds with the page's, and the progress bars of a file on its
 * way, a backup or a restore and a task card were drawn by backgrounds alone: track and fill both became the page, an
 * empty strip. One pair of classes for all of them, read in forced colors only (index.css): `progress-track`, a
 * CanvasText frame, and `progress-fill`, a Highlight fill.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const CSS = readFileSync(join(SRC, "index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const FORCED = "@media (forced-colors: active)";

/** Every `@media (forced-colors: active)` block's rules (selector -> declarations), and the stylesheet without them. */
function forced(): { rules: Map<string, Record<string, string>>; rest: string } {
  const rules = new Map<string, Record<string, string>>();
  let rest = "", at = 0;
  for (let start = CSS.indexOf(FORCED); start >= 0; start = CSS.indexOf(FORCED, at)) {
    const open = CSS.indexOf("{", start);
    let depth = 1, i = open + 1;
    for (; depth > 0; i++) depth += CSS[i] === "{" ? 1 : CSS[i] === "}" ? -1 : 0;
    for (const [, selector, body] of CSS.slice(open + 1, i - 1).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decls: Record<string, string> = {};
      for (const [, name, value] of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) decls[name] = value.trim();
      rules.set(selector.trim(), decls);
    }
    rest += CSS.slice(at, start);
    at = i;
  }
  return { rules, rest: rest + CSS.slice(at) };
}

describe("a progress bar in forced colors (index.css)", () => {
  it("is a CanvasText frame on the page's colour with a Highlight fill, both kept as drawn, only in forced colors", () => {
    const { rules, rest } = forced();
    expect(rules.get(".progress-track"), `.progress-track inside ${FORCED}`).toMatchObject({ "forced-color-adjust": "none", border: "1px solid CanvasText", background: "Canvas" });
    expect(rules.get(".progress-fill"), `.progress-fill inside ${FORCED}`).toMatchObject({ "forced-color-adjust": "none", background: "Highlight" });
    // Normal colours: nothing reads the classes outside forced colors.
    expect(rest).not.toMatch(/progress-(track|fill)/);
  });
});

/** The bar's track carries `progress-track`, and its one child, the fill, `progress-fill`. */
function drawn(bar: HTMLElement) {
  expect(bar).toHaveAttribute("role", "progressbar");
  expect(bar).toHaveClass("progress-track");
  expect(bar.children).toHaveLength(1);
  expect(bar.firstElementChild).toHaveClass("progress-fill");
}

const GB = 1024 ** 3;
const task = (extra: Record<string, unknown> = {}) => readStatusCard({ kind: "task", id: "relay", title: "Fix relay rotation", status: "running", progress: 40, ...extra }) as TaskCard;

describe("the bars that carry them", () => {
  beforeEach(() => {
    everythingOnScreen();
    vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null);
  });

  it.each([undefined, "paused", "waiting"] as const)("a file on its way (stage %s)", (stage) => {
    const file = { id: "chat1-in-abc", name: "movie.mkv", size: 4.2 * GB, mime: "video/x-matroska" };
    fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: { [file.id]: { state: "transferring", stage, pausedBy: "me", transferred: 0.62 * file.size, size: file.size } } });
    renderApp(<FileBubble file={file} peerName="Ana" />);
    drawn(screen.getByTestId("file-progress"));
  });

  it.each([
    ["a backup, its size known", { kind: "backup", stage: "writing", bytes: 25, bytesTotal: 100 }],
    ["a restore, its size not known yet (the pulsing third)", { kind: "restore", stage: "opening", bytes: 0, bytesTotal: 0 }],
  ] as const)("%s", (_, job) => {
    renderApp(<BackupProgress job={{ sealed: true, files: 1, filesTotal: 4, ...job }} onCancel={() => {}} />);
    drawn(screen.getByTestId("backup-progress-bar"));
  });

  it("a task card in the chat", () => {
    renderApp(<ProgressBar card={task()} />);
    drawn(screen.getByTestId("status-card-progress"));
  });

  it("a task card on the Tasks board", () => {
    const board: BoardTask = { key: "k", linkId: "link-1", messageId: "m1", card: task(), author: "peer", at: Date.now(), botKey: "peer", bot: "Bot", chat: "Ana" };
    renderApp(<BoardCard task={board} grouping="status" now={Date.now()} onOpen={() => {}} />);
    drawn(screen.getByTestId("board-card-progress"));
  });
});

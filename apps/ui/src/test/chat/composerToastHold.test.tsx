import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import type { Language } from "../../lib/settings";
import { renderApp } from "../render";

// covers: chat.paired.send

/** What a group answers a file it paces, and a text over 16 KiB, in the languages slowest to read. */
const PACED_JA = "このグループに短時間で多くのファイルを送りました。3分待ってから、もう一度送ってください。";
const TOO_LONG_ZH = "内容过长，无法发送（18,000 字节，上限为 16,384）。请缩短，或作为文件发送。";
const PACED_AR = "أرسلت ملفات كثيرة إلى هذه المجموعة للتو. انتظر 3 دقائق، ثم أرسله مرة أخرى.";
const SHORT_EN = "Could not send the file.";

/** The mean silent reading speed (IReST, characters a minute, spaces not counted): how long a line takes to read. */
const readMs = (text: string, perMinute: number) => [...text.replace(/\s/g, "")].length / perMinute * 60_000;

const sendRefused = async (refusal: string, language: Language) => {
  renderApp(<LockScreenProvider><MessageInput draftId={`hold-${language}`} onSend={async () => null} onSendFile={async () => refusal} /></LockScreenProvider>, { language });
  fireEvent.change(screen.getByTestId("file-input"), { target: { files: [new File(["x"], "a.txt", { type: "text/plain" })] } });
  return screen.findByRole("alert");
};
const card = () => screen.queryByText(/./, { selector: "[role='alert'] span" });
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

describe("a refusal above the composer", () => {
  it.each([["ja", PACED_JA, 357], ["zh", TOO_LONG_ZH, 255], ["ar", PACED_AR, 612]] as const)(
    "in %s stays up at least as long as it takes to read, then goes by itself", async (language, refusal, perMinute) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await sendRefused(refusal, language);
      expect(card()).toHaveTextContent(refusal);
      wait(Math.max(5_200, readMs(refusal, perMinute)));
      expect(card()).toHaveTextContent(refusal);
      wait(30_000);
      expect(card()).toBeNull();
    });

  it("a short English line still goes after 5 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await sendRefused(SHORT_EN, "en");
    wait(4_800);
    expect(card()).toHaveTextContent(SHORT_EN);
    wait(400);
    expect(card()).toBeNull();
  });

  it("stays while it is pointed at, and goes once the pointer leaves", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const alert = await sendRefused(PACED_JA, "ja");
    fireEvent.pointerEnter(alert.firstElementChild!);
    wait(60_000);
    expect(card()).toHaveTextContent(PACED_JA);
    fireEvent.pointerLeave(alert.firstElementChild!);
    wait(30_000);
    expect(card()).toBeNull();
  });

  it("stays while its × has the focus; closed, it hands the focus to the message field", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const alert = await sendRefused(PACED_JA, "ja");
    const close = within(alert).getByRole("button");
    act(() => close.focus());
    wait(60_000);
    expect(card()).toHaveTextContent(PACED_JA);
    expect(close).toHaveFocus();
    fireEvent.click(close);
    expect(card()).toBeNull();
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("goes by itself once the focus has left its ×", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const alert = await sendRefused(PACED_JA, "ja");
    const close = within(alert).getByRole("button");
    act(() => close.focus());
    wait(60_000);
    act(() => screen.getByRole("textbox").focus());
    wait(30_000);
    expect(card()).toBeNull();
    expect(screen.getByRole("textbox")).toHaveFocus();
  });
});

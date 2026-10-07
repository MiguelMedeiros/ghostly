import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readStatusCard, statusCardText, type UsageCard } from "@ghostly/core";
import type { CardIndexRow } from "@ghostly/browser/shared/types";
import { ChatRow, type ChatRowProps } from "../../components/ChatRow";
import { MessageBubble } from "../../components/MessageBubble";
import { TasksButton } from "../../components/chat/TasksButton";
import { UsageButton, UsagePill } from "../../components/chat/UsageMeter";
import { useUsageOf } from "../../hooks/useUsage";
import { cardLine } from "../../lib/statusCards";
import type { ChatMessage } from "../../lib/types";
import { USAGE_STALE_MS, usageByChat, usageLevel, type UsageEntry } from "../../lib/usage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.status-cards.usage

/** A bot's usage (WISP 405 § Usage): the meter's levels, the chat row's pill, the header's details, the card's line. */

const NOW = Date.now();
const HOUR = 3_600_000;
const usage = (extra: Record<string, unknown> = {}) => readStatusCard({ kind: "usage", id: "usage", label: "Claude", left: 62, ...extra }) as UsageCard;
const entry = (extra: Record<string, unknown> = {}, at = NOW - 60_000): UsageEntry => ({ card: usage(extra), messageId: "m1", at });
let n = 0;
const row = (linkId: string, card: UsageCard, patch: Partial<CardIndexRow> = {}): CardIndexRow => ({ linkId, id: `m${++n}`, card, sender: "peer", timestamp: NOW - 10 * 60_000 + n, ...patch });

describe("the meter's level", () => {
  it("is plain while there is plenty, amber under 20%, red under 5%", () => {
    expect(usageLevel(entry({ left: 62 }), NOW)).toBe("ok");
    expect(usageLevel(entry({ left: 20 }), NOW)).toBe("ok");
    expect(usageLevel(entry({ left: 19 }), NOW)).toBe("low");
    expect(usageLevel(entry({ left: 5 }), NOW)).toBe("low");
    expect(usageLevel(entry({ left: 4 }), NOW)).toBe("critical");
    expect(usageLevel(entry({ left: undefined, used: 990, limit: 1000 }), NOW)).toBe("critical");
  });

  it("is stale once the numbers are 6 hours old, by the card's own time or its message's, or the window has reset", () => {
    expect(usageLevel(entry({ left: 3 }, NOW - USAGE_STALE_MS - 1), NOW)).toBe("stale");
    expect(usageLevel(entry({ left: 3, updatedAt: NOW - 7 * HOUR }), NOW)).toBe("stale");
    expect(usageLevel(entry({ left: 3, resetsAt: NOW - 1 }), NOW - 2)).toBe("critical");
    expect(usageLevel({ card: { ...usage({ left: 3 }), resetsAt: NOW - 1 }, messageId: "m1", at: NOW }, NOW)).toBe("stale");
  });
});

describe("the usage card that stands for a chat", () => {
  it("is the contact's that changed last; mine and a group's are not on the meter", () => {
    const rows = [
      row("link-1", usage({ left: 80 }), { editedAt: NOW - 5 * 60_000 }),
      row("link-1", usage({ id: "other", left: 40 }), { timestamp: NOW - 30 * 60_000 }),
      row("link-1", usage({ left: 1 }), { sender: "me", timestamp: NOW }),
      row("group:g1", usage({ left: 2 }), { member: "bot-key", timestamp: NOW }),
    ];
    const by = usageByChat(rows);
    expect([...by.keys()]).toEqual(["link-1"]);
    expect(by.get("link-1")!.card.left).toBe(80);
  });
});

describe("the pill", () => {
  it("shows the percent, its level for tests and colour, and says it all to a screen reader", () => {
    renderApp(<>
      <UsagePill entry={entry({ left: 62 })} testId="pill-ok" />
      <UsagePill entry={entry({ left: 12 })} testId="pill-low" />
      <UsagePill entry={entry({ left: 3 })} testId="pill-critical" />
      <UsagePill entry={entry({ left: 3 }, NOW - 7 * HOUR)} testId="pill-stale" />
    </>);
    expect(screen.getByTestId("pill-ok")).toHaveAttribute("data-level", "ok");
    expect(screen.getByTestId("pill-ok")).toHaveTextContent("62%");
    expect(screen.getByTestId("pill-ok")).toHaveAccessibleName("Claude: 62% left");
    expect(screen.getByTestId("pill-low")).toHaveAttribute("data-level", "low");
    expect(screen.getByTestId("pill-low").className).toContain("text-warn-ink");
    expect(screen.getByTestId("pill-critical")).toHaveAttribute("data-level", "critical");
    expect(screen.getByTestId("pill-critical").className).toContain("text-danger");
    expect(screen.getByTestId("pill-stale")).toHaveAttribute("data-level", "stale");
    expect(screen.getByTestId("pill-stale")).toHaveAccessibleName("Claude: 3% left (not updated lately)");
    expect(screen.getByTestId("pill-ok").className).not.toMatch(/amber|danger/);
  });

  it("sits on a chat's row beside the unread count", () => {
    const props = { chatId: "chat-1", density: "compact", active: false, label: "Hermes", named: true, keyLabel: "abc…xyz", peerPubKey: "peer", time: "12:00",
      unread: 2, pinned: false, syncing: false, creator: false, onOpen: () => {}, onTogglePin: () => {}, onDelete: () => {}, deleteLabel: "Delete" } as ChatRowProps;
    renderApp(<ChatRow {...props} usage={entry({ left: 12 })} />);
    const pill = screen.getByTestId("chat-row-usage");
    expect(pill).toHaveAttribute("data-level", "low");
    expect(pill).toHaveAttribute("data-left", "12");
    expect(screen.getByTestId("chat-row-unread")).toHaveTextContent("2");
  });
});

/** The header's meter for a contact, from the engine's card index, as the chat page reads it. */
function Header({ peer }: { peer: string }) {
  const found = useUsageOf(peer);
  return found ? <UsageButton entry={found} /> : <p data-testid="no-usage">none</p>;
}

describe("the header's meter", () => {
  it("follows the contact's latest usage card from the card index, and opens the details with an ⓘ", async () => {
    const rendered = renderApp(<Header peer="peer-hermes" />);
    rendered.engine.on("statusCardIndex", () => [row("link-1", usage({ left: 62, account: "work", window: "5 h", resetsAt: NOW + 3 * HOUR, used: 380, limit: 1000,
      windows: [{ window: "week", left: 80 }] }), { editedAt: NOW - 120_000 })]).setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer-hermes" })], groups: [] });
    const pill = await screen.findByTestId("chat-usage");
    expect(pill).toHaveAttribute("data-level", "ok");
    // With when it resets, the time of day within a day.
    expect(pill.textContent).toMatch(/^62%·\d{2}:\d{2}/);
    await rendered.user.click(screen.getByTestId("chat-usage-open"));
    const panel = screen.getByTestId("chat-usage-panel");
    expect(panel).toHaveAttribute("data-layout", "popover");
    expect(within(panel).getByRole("heading")).toHaveTextContent("Claude");
    expect(within(panel).getByTestId("usage-details-left")).toHaveTextContent("62% · 5 h");
    expect(within(panel).getByTestId("usage-details-used")).toHaveTextContent("380 of 1000 used");
    expect(within(panel).getByTestId("usage-details-account")).toHaveTextContent("work");
    expect(within(panel).getByTestId("usage-details-window-0")).toHaveTextContent("week80% left");
    expect(within(panel).getByTestId("usage-details-updated")).toHaveTextContent("2 min ago");
    expect(within(panel).queryByTestId("chat-usage-info-text")).not.toBeInTheDocument();
    await rendered.user.click(within(panel).getByTestId("chat-usage-info"));
    expect(within(panel).getByTestId("chat-usage-info-text")).toHaveTextContent("What the bot says it has left. Ghostly doesn't check it.");
    await rendered.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("chat-usage-panel")).not.toBeInTheDocument());
    expect(screen.getByTestId("chat-usage-open")).toHaveFocus();
  });

  it("is not there without a usage card from the contact", async () => {
    const rendered = renderApp(<Header peer="peer-hermes" />);
    rendered.engine.on("statusCardIndex", () => [row("link-1", usage(), { sender: "me" })]).setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer-hermes" })], groups: [] });
    await waitFor(() => expect(rendered.engine.callsTo("statusCardIndex").length).toBeGreaterThan(0));
    expect(screen.getByTestId("no-usage")).toBeInTheDocument();
  });
});

describe("a usage card in the chat", () => {
  const message = (c: UsageCard): ChatMessage => ({ id: "m1", text: statusCardText(c), sender: "peer", timestamp: NOW - 60_000, card: c });

  it("is one quiet line instead of its text, that opens in place", async () => {
    const c = usage({ left: 12, window: "5 h", resetsAt: NOW + 2 * HOUR });
    const { user } = renderApp(<MessageBubble message={message(c)} peerPubKey="peer" />);
    const shown = screen.getByTestId("status-card");
    expect(shown).toHaveAttribute("data-kind", "usage");
    expect(shown).toHaveAttribute("data-level", "low");
    expect(within(shown).getByTestId("status-card-title")).toHaveTextContent("Claude");
    expect(shown).toHaveTextContent("12% left");
    expect(shown).toHaveTextContent(/resets \d{2}:\d{2}/);
    expect(screen.queryByTestId("message-text")).not.toBeInTheDocument();
    expect(screen.queryByTestId("usage-details")).not.toBeInTheDocument();
    await user.click(within(shown).getByTestId("status-card-toggle"));
    expect(screen.getByTestId("usage-details")).toBeInTheDocument();
  });

  it("is no task: the Tasks button stays away, and its line elsewhere is the label and percent", () => {
    renderApp(<TasksButton rows={[{ id: "m1", card: usage(), sender: "peer", timestamp: NOW }]} />);
    expect(screen.queryByTestId("chat-tasks")).not.toBeInTheDocument();
    expect(cardLine(usage())).toBe("📊 Claude · 62%");
    expect(cardLine(usage({ label: undefined, left: 7 }))).toBe("📊 7%");
  });
});

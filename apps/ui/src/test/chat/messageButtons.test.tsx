import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { readStatusCard, type ButtonsCard } from "@ghostly/core";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../../components/MessageBubble";
import { TasksButton } from "../../components/chat/TasksButton";
import { buttonsViews, compactPresses } from "../../lib/buttons";
import { cardEntries } from "../../lib/statusCards";
import { quoteFor, replyIndex } from "../../lib/replies";
import type { ChatMessage } from "../../lib/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.buttons

/** A bot's buttons under its message (WISP 406 · Message Buttons): the text in its bubble, the buttons under it, a tap presses. */

const buttons = (extra: Record<string, unknown> = {}): ButtonsCard => readStatusCard({
  kind: "buttons", id: "deploy",
  buttons: [{ id: "yes", label: "Yes", style: "primary", once: true }, { id: "no", label: "No" }, { id: "stop", label: "Stop it", style: "danger" }],
  ...extra,
}) as ButtonsCard;

const question = (card: ButtonsCard = buttons(), patch: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: "paired-q1", ref: "q1", text: "Deploy to production?", sender: "peer", timestamp: 1_700_000_000_000, card, ...patch });

/** The bubble as a paired chat draws it: its buttons' state from the chat's history. */
function bubble(message: ChatMessage, history: ChatMessage[] = [message]) {
  return <MessageBubble message={message} peerPubKey="peer" linkId="link-a" buttons={buttonsViews(history, m => m.ref).get(message.id)} />;
}

const shown = () => screen.getAllByTestId("message-button");
const byId = (id: string) => shown().find(b => b.dataset.buttonId === id)!;

describe("buttons under a bot's message", () => {
  it("shows the message's text in its bubble and the buttons under it, a group named Answers", () => {
    renderApp(bubble(question()));
    expect(screen.getByTestId("message-text")).toHaveTextContent("Deploy to production?");
    expect(screen.queryByTestId("status-card")).not.toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Answers" });
    expect(group).toHaveAttribute("data-testid", "message-buttons");
    expect(within(group).getAllByRole("button").map(b => b.textContent)).toEqual(["Yes", "No", "Stop it"]);
    expect(byId("yes")).toHaveAttribute("data-style", "primary");
    // The card's surface (index.css `.message-button`): its look follows `data-style`, never a solid fill of its own.
    for (const b of shown()) expect(b.className).toContain("message-button");
    expect(byId("stop")).toHaveAttribute("data-style", "danger");
    expect(byId("no")).toHaveAttribute("data-style", "neutral");
    for (const b of shown()) {
      expect(b).toHaveAttribute("aria-pressed", "false");
      expect(b).not.toHaveAttribute("aria-disabled");
    }
    // Under the bubble, not in it.
    expect(document.querySelector("[data-message-bubble]")).not.toContainElement(group);
  });

  it("a tap sends the press, shows it sending, then marks it chosen; a once button closes them all", async () => {
    let answer!: (v: { error: null }) => void;
    fakeEngine.on("pressButton", () => new Promise(r => { answer = r; }));
    const { user } = renderApp(bubble(question()));
    await user.click(byId("yes"));
    expect(fakeEngine.callsTo("pressButton")).toEqual([{ linkId: "link-a", messageId: "paired-q1", buttonId: "yes" }]);
    expect(byId("yes")).toHaveAttribute("aria-busy", "true");
    expect(byId("yes")).toHaveAttribute("title", "Sending…");
    // No second press while one is on its way.
    await user.click(byId("no"));
    expect(fakeEngine.callsTo("pressButton")).toHaveLength(1);
    await act(async () => answer({ error: null }));
    expect(byId("yes")).not.toHaveAttribute("aria-busy");
    expect(byId("yes")).toHaveAttribute("aria-pressed", "true");
    expect(byId("yes")).toHaveAttribute("data-chosen", "true");
    expect(within(byId("yes")).getByTestId("message-button-check")).toHaveTextContent("✓");
    // `once`: answered, nothing more to press.
    for (const b of shown()) expect(b).toHaveAttribute("aria-disabled", "true");
    await user.click(byId("no"));
    expect(fakeEngine.callsTo("pressButton")).toHaveLength(1);
  });

  it("says so briefly when the engine refuses", async () => {
    fakeEngine.on("pressButton", () => ({ error: "Those buttons are closed", refused: true }));
    const { user } = renderApp(bubble(question()));
    await user.click(byId("no"));
    expect(await screen.findByTestId("message-buttons-error")).toHaveTextContent("Couldn't send");
    expect(byId("no")).toHaveAttribute("aria-pressed", "false");
    expect(byId("no")).not.toHaveAttribute("aria-disabled");
  });

  it("my reply typed as \"yes\" answers a once question, as the bot takes it: no button offers a press after it", () => {
    const q = question();
    const typed: ChatMessage = { id: "p1", text: "yes", sender: "me", timestamp: 2e12, replyTo: { id: "q1", snippet: "Deploy to production?", from: "peer", messageId: "paired-q1" } };
    renderApp(bubble(q, [q, typed]));
    expect(byId("yes")).toHaveAttribute("aria-pressed", "true");
    for (const button of shown()) expect(button).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps my last press from the history, and the bot's answer over it", () => {
    const press = (id: string, button: string, label: string, timestamp: number): ChatMessage =>
      ({ id, text: label, sender: "me", timestamp, replyTo: { id: "q1", snippet: "Deploy to production?", from: "peer", button, messageId: "paired-q1" } });
    const q = question();
    const history = [q, press("p1", "stop", "Stop it", 2e12), press("p2", "no", "No", 2e12 + 1)];
    const { unmount } = renderApp(bubble(q, history));
    expect(byId("no")).toHaveAttribute("aria-pressed", "true");
    expect(byId("stop")).toHaveAttribute("aria-pressed", "false");
    // Not a `once` button: still open.
    expect(byId("yes")).not.toHaveAttribute("aria-disabled");
    unmount();
    const answered = question(buttons({ chosen: "yes" }));
    renderApp(bubble(answered, [answered, ...history.slice(1)]));
    expect(byId("yes")).toHaveAttribute("aria-pressed", "true");
    expect(byId("no")).toHaveAttribute("aria-pressed", "false");
  });

  it("closed by the bot: every button off, the chosen one still marked, and a tap asks the engine nothing", async () => {
    const { user } = renderApp(bubble(question(buttons({ chosen: "no", closed: true }))));
    for (const b of shown()) expect(b).toHaveAttribute("aria-disabled", "true");
    expect(byId("no")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("message-buttons-closed")).toHaveTextContent("Closed");
    await user.click(byId("yes"));
    expect(fakeEngine.callsTo("pressButton")).toHaveLength(0);
  });

  it("on my own message they are shown, and none of them presses", async () => {
    const { user } = renderApp(bubble(question(buttons(), { sender: "me" })));
    for (const b of shown()) expect(b).toHaveAttribute("aria-disabled", "true");
    await user.click(byId("no"));
    expect(fakeEngine.callsTo("pressButton")).toHaveLength(0);
  });

  it("reads in Portuguese", () => {
    renderApp(bubble(question(buttons({ closed: true }))), { language: "pt" });
    expect(screen.getByRole("group", { name: "Respostas" })).toBeInTheDocument();
    expect(screen.getByTestId("message-buttons-closed")).toHaveTextContent("Encerrada");
  });
});

describe("a press in the chat", () => {
  it("reads \"↩ Yes\", not a quote, and a tap goes to the question", async () => {
    const q = question();
    const reply: ChatMessage = { id: "p1", text: "Yes", sender: "me", timestamp: 2e12, replyTo: { id: "q1", snippet: "Deploy to production?", from: "peer", button: "yes", messageId: "paired-q1" } };
    const quote = quoteFor(reply.replyTo!, replyIndex([q, reply]), () => "Bot");
    const { user } = renderApp(<>
      {bubble(q, [q, reply])}
      <MessageBubble message={reply} peerPubKey="peer" linkId="link-a" quote={quote} compactPress={compactPresses([q, reply], m => m.ref).has("p1")} />
    </>);
    const line = screen.getByTestId("button-press");
    expect(line).toHaveTextContent("↩ Yes");
    expect(line).toHaveAttribute("title", "Go to the question");
    expect(screen.queryByTestId("message-quote")).not.toBeInTheDocument();
    await user.click(line);
    expect(document.querySelector("[data-message-id=paired-q1]")).toHaveAttribute("data-reply-flash");
  });

  it("a label that looks like a sum or a link stays a label", () => {
    const reply: ChatMessage = { id: "p1", text: "https://example.com/a.png", sender: "peer", timestamp: 2e12, replyTo: { id: "q1", snippet: "Deploy to production?", button: "img" } };
    renderApp(<MessageBubble message={reply} peerPubKey="peer" compactPress />);
    expect(screen.getByTestId("button-press")).toHaveTextContent("↩ https://example.com/a.png");
    expect(screen.queryByTestId("picture-link")).not.toBeInTheDocument();
    expect(screen.queryByTestId("image-reveal")).not.toBeInTheDocument();
  });
});

describe("a question changed after it was answered", () => {
  const reply: ChatMessage = { id: "p1", text: "Yes", sender: "me", timestamp: 2e12, replyTo: { id: "q1", snippet: "Deploy to production?", from: "peer", button: "yes", messageId: "paired-q1" } };

  it("a press on the question as it reads now is compact; on a reworded one, or naming no button of it, it is a reply with its quote", () => {
    const q = question();
    expect(compactPresses([q, reply], m => m.ref)).toEqual(new Set(["p1"]));
    // The bot reworded the question after the press: the reply keeps the words the person answered.
    const reworded = question(buttons(), { text: "Deploy the database migration?", edit: { seq: 1, at: 3e12, history: [{ at: 1, text: "Deploy to production?" }] } });
    expect(compactPresses([reworded, reply], m => m.ref).size).toBe(0);
    // A `b` naming no button, or a message without buttons: a reply.
    expect(compactPresses([q, { ...reply, replyTo: { ...reply.replyTo!, button: "nope" } }], m => m.ref).size).toBe(0);
    expect(compactPresses([{ ...q, card: undefined }, reply], m => m.ref).size).toBe(0);
    // A text that is not the label of the button it names ("No" naming yes): a reply, never "↩ No" for a Yes.
    expect(compactPresses([q, { ...reply, text: "No" }], m => m.ref).size).toBe(0);
    expect(compactPresses([q, { ...reply, text: " yes " }], m => m.ref)).toEqual(new Set(["p1"]));
    const quote = quoteFor(reply.replyTo!, replyIndex([reworded, reply]), () => "Bot");
    renderApp(<MessageBubble message={reply} peerPubKey="peer" linkId="link-a" quote={quote} compactPress={false} />);
    expect(screen.queryByTestId("button-press")).not.toBeInTheDocument();
    expect(screen.getByTestId("message-quote")).toHaveTextContent("Deploy to production?");
  });

  it("a new text shows the question edited; the answer marked or closed alone does not", () => {
    const marked = question(buttons({ chosen: "yes", closed: true }), { edit: { seq: 1, at: 3e12, history: [] } });
    const { unmount } = renderApp(bubble(marked));
    expect(screen.queryByTestId("message-edited")).not.toBeInTheDocument();
    unmount();
    renderApp(bubble(question(buttons(), { text: "Deploy the migration?", edit: { seq: 2, at: 3e12, history: [{ at: 1, text: "Deploy to production?" }] } })));
    expect(screen.getByTestId("message-edited")).toBeInTheDocument();
  });

  it("a second tap within a second is not taken, and nothing is said", async () => {
    fakeEngine.on("pressButton", () => ({ error: "One press a second", refused: true, paced: true }));
    const { user } = renderApp(bubble(question()));
    await user.click(byId("no"));
    expect(fakeEngine.callsTo("pressButton")).toHaveLength(1);
    expect(screen.queryByTestId("message-buttons-error")).not.toBeInTheDocument();
  });
});

describe("buttons are not a status card", () => {
  it("the Tasks button counts none of them", () => {
    const rows = [question()];
    expect(cardEntries(rows)).toEqual([]);
    renderApp(<TasksButton rows={rows} />);
    expect(screen.queryByTestId("chat-tasks")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Tasks/ })).not.toBeInTheDocument();
  });
});

describe("buttons in a group", () => {
  const bot = "b".repeat(52), me = "m".repeat(52);
  const row = (patch: Partial<StoredMessage>): StoredMessage =>
    ({ linkId: "group:group-1", sender: "peer", member: bot, timestamp: 1_700_000_000_000, text: "", ...patch }) as StoredMessage;

  it("a tap presses on the group's link, and my earlier press there is marked", async () => {
    const q = row({ id: "group-1:q1", text: "Which relay?", card: readStatusCard({ kind: "buttons", id: "relay", buttons: [{ id: "a", label: "Relay A" }, { id: "b", label: "Relay B" }] }) });
    const mine = row({ id: "group-1:p1", sender: "me", member: undefined, text: "Relay B", timestamp: 1_700_000_000_500, replyTo: { id: "group-1:q1", snippet: "Which relay?", from: "peer", member: bot, button: "b", messageId: "group-1:q1" } });
    fakeEngine.on("groupMessages", () => [q, mine]).on("updateSettings", () => undefined).on("setGroupTyping", () => undefined)
      .on("pressButton", () => ({ error: null }))
      .update({ groups: [groupView({ status: "active", epoch: 1, members: [
        { key: me, role: "member", me: true, online: true, missing: 0 }, { key: bot, nick: "Builder", role: "member", me: false, online: true, missing: 0 },
      ] })] });
    const { user } = renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    await screen.findByText("Which relay?");
    expect(byId("b")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("button-press")).toHaveTextContent("↩ Relay B");
    await user.click(byId("a"));
    expect(fakeEngine.callsTo("pressButton")).toEqual([{ linkId: "group:group-1", messageId: "group-1:q1", buttonId: "a" }]);
    expect(byId("a")).toHaveAttribute("aria-pressed", "true");
  });
});

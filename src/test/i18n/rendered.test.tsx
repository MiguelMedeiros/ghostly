import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { GroupChat } from "../../pages/GroupChat";
import { groupView } from "../fakeEngine";
import { renderApp } from "../render";
import { LANGUAGES, SECTIONS, lookup } from "./locales";

// covers: app.i18n

/** Something like `chat.deleteMessage` or `common.cancel`: what `t()` shows for a key its locale lacks. */
const RAW_KEY = new RegExp(`\\b(?:${SECTIONS.join("|")})(?:\\.[a-zA-Z]+)+\\b`, "g");

/** The text a person sees or hears in `root`: its text, and the labels screen readers and tooltips read out. */
function visibleStrings(root: HTMLElement): string[] {
  const labels = [...root.querySelectorAll("[title], [aria-label], [placeholder], [alt]")].flatMap((el) =>
    ["title", "aria-label", "placeholder", "alt"].map((a) => el.getAttribute(a)).filter((v): v is string => !!v),
  );
  // Text node by text node: `textContent` glues neighbours together ("Deletex").
  const texts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node.nodeValue ?? "");
  return [...texts, ...labels];
}

function rawKeys(root: HTMLElement): string[] {
  return visibleStrings(root).flatMap((s) => s.match(RAW_KEY) ?? []);
}

it("the raw-key check catches a key shown as is", () => {
  const root = document.createElement("div");
  root.innerHTML = `<p>chat.deleteMessage</p><button aria-label="common.cancel">x</button><p>Hello. Chat.</p>`;
  expect(rawKeys(root)).toEqual(["chat.deleteMessage", "common.cancel"]);
});

const t = (language: (typeof LANGUAGES)[number], key: string) => lookup(language, key)!;

describe.each(LANGUAGES)("in %s", (language) => {
  it("a message's delete menu is translated, with no raw key", async () => {
    const { user, container } = renderApp(
      <MessageBubble message={{ id: "m1", text: "Hello there", sender: "peer", timestamp: 0 }} onDelete={() => {}} />,
      { language },
    );

    expect(screen.getByTestId("message-options")).toHaveAccessibleName(t(language, "chat.message.options"));
    await user.click(screen.getByTestId("message-options"));
    expect(screen.getByTestId("message-details")).toHaveTextContent(t(language, "chat.message.details"));
    expect(screen.getByTestId("message-delete")).toHaveTextContent(t(language, "chat.deleteMessage"));
    await user.click(screen.getByTestId("message-delete"));

    const menu = screen.getByTestId("message-delete-menu");
    expect(menu).toHaveTextContent(t(language, "chat.deleteMessageHint"));
    expect(within(menu).getByRole("button", { name: t(language, "common.cancel") })).toBeInTheDocument();
    expect(screen.getByTestId("message-delete-confirm")).toHaveTextContent(t(language, "common.delete"));
    expect(rawKeys(container)).toEqual([]);
  });

  it("an active group with its history and composer shows no raw key", async () => {
    const { engine, container } = renderApp(
      <Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>,
      { route: "/group/group-1", language },
    );
    engine
      .on("groupMessages", () => [{ linkId: "group:group-1", id: "g1", text: "Hi all", sender: "peer", timestamp: 1, via: "datalink", member: "k2" }])
      .on("updateSettings", () => undefined)
      .update({
        groups: [groupView({
          status: "active",
          members: [
            { key: "k1", role: "admin", me: true, online: true, missing: 0 },
            { key: "k2", role: "member", me: false, nick: "Ana", online: true, missing: 0 },
          ],
        })],
      });

    expect(await screen.findByText("Hi all")).toBeInTheDocument();
    expect(screen.getByTestId("group-name")).toHaveTextContent("Friends");
    expect(rawKeys(container)).toEqual([]);
  });
});

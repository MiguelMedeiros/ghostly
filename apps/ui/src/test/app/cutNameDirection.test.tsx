import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GroupMemberView } from "@ghostly/browser/shared/types";
import { GroupPaymentComposer } from "../../components/GroupPaymentComposer";
import { MessageBubble } from "../../components/MessageBubble";
import { ReplyBar, ReplyQuote } from "../../components/chat/ReplyQuote";
import { fakeEngine, groupView } from "../fakeEngine";
import { everyWallet } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: groups.payments.member, chat.location.card, chat.replies, app.i18n

/*
 * A member's name and a place's name are someone's own words, in any script, and long enough to be cut. In Arabic a
 * Latin one cut by the line's direction lost its start ("… longue durée"): the box that cuts it lays it out by its
 * own letters (`dir="auto"`), as a chat's name does, so it keeps its start and ends in "…".
 */

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
const NAME = "Travail de très longue durée";
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });

describe("a person's own words in Arabic keep their own direction where they are cut", () => {
  it("a member's name in a group payment's list of whom to pay", () => {
    const group = groupView({ status: "active", epoch: 1, myKey: ME, members: [member({ me: true }), member({ key: ALICE, nick: NAME })] });
    fakeEngine.setState({ groups: [group], wallet: everyWallet() });
    renderApp(<GroupPaymentComposer group={group} onClose={() => {}} />, { language: "ar" });
    const name = within(screen.getByTestId("group-pay-recipient")).getByText(NAME, { exact: true });
    expect(name).toHaveAttribute("dir", "auto");
    expect(name).toHaveClass("truncate");
  });

  it("a place's name on a location card", () => {
    renderApp(<MessageBubble message={{ id: "m1", text: "geo:38.6916,-9.2160?q=38.6916,-9.2160(Torre%20de%20Bel%C3%A9m%20e%20arredores)", sender: "peer", timestamp: 1_700_000_000_000 }} />, { language: "ar" });
    const name = screen.getByTestId("location-name");
    expect(name).toHaveTextContent("Torre de Belém e arredores");
    expect(name).toHaveAttribute("dir", "auto");
    expect(name).toHaveClass("truncate");
  });

  it("the name of whom a reply quotes, above the reply and in the composer's bar", () => {
    renderApp(<>
      <ReplyQuote quote={{ state: "found", name: NAME, snippet: "Bonjour", mine: false, targetId: "m1" }} />
      <ReplyBar name={NAME} snippet="Bonjour" mine={false} onCancel={() => {}} />
    </>, { language: "ar" });
    for (const name of screen.getAllByTestId("reply-quote-name")) {
      expect(name).toHaveTextContent(NAME);
      expect(name).toHaveAttribute("dir", "auto");
      expect(name).toHaveClass("truncate", "max-w-full", "self-start");
    }
  });
});

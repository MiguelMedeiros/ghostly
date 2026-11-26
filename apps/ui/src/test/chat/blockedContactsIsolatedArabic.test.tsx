import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BlockedContacts } from "../../components/settings/BlockedContacts";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.i18n

/*
 * Settings → Blocked contacts in Arabic: each blocked contact's name (its chat's label, or the name the contact chose) is
 * drawn in its own <bdi>, as Devices draws a device's name. Drawn raw, the row took the page's right-to-left direction and
 * "Ana (2)" read ")Ana (2". The Unblock button's name (an aria-label, which cannot hold a <bdi>) keeps the name between
 * isolate marks. A contact with no name is drawn in the app's own words ("Contact · <tag>"), not as a chosen name.
 */

const ANA = "a".repeat(52);
const BOB = "b".repeat(52);
const GONE = "g".repeat(52);

describe("Settings → Blocked contacts, in Arabic, draws each contact's name isolated", () => {
  it("each row's name in its own <bdi>; the Unblock button names it between FSI and PDI", () => {
    const view = renderApp(<BlockedContacts />, { language: "ar" });
    act(() => view.engine.update({
      links: [linkView({ id: "link-a", peerPubKeyZ32: ANA, label: "Ana (2)" }), linkView({ id: "link-b", peerPubKeyZ32: BOB, peerNick: "Bob" })],
      settings: { blockedContacts: [ANA, BOB, GONE] } as never,
    }));
    const [ana, bob, gone] = screen.getAllByTestId("settings-blocked-contact");
    for (const [row, name] of [[ana!, "Ana (2)"], [bob!, "Bob"]] as const) {
      expect([...row.querySelectorAll("bdi")].map((bdi) => bdi.textContent)).toEqual([name]);
      expect(within(row).getByRole("button")).toHaveAccessibleName(`إلغاء حظر \u2068${name}\u2069`);
    }
    // No name: the app's words, with the key's tag, as the chat list says it.
    expect(gone).toHaveTextContent(`جهة اتصال · ${GONE.slice(0, 6)}`);
    expect(gone!.querySelectorAll("bdi")).toHaveLength(0);
    expect(within(gone!).getByRole("button")).toHaveAccessibleName(`إلغاء حظر \u2068جهة اتصال · ${GONE.slice(0, 6)}\u2069`);
  });
});

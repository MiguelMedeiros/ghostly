import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Services } from "../../pages/Services";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: services.open

const name = "Family photo album and recipe planner app XYZ";
const ana: ChatSession = { id: "ana", profile: "paired-chat/1", mySeedB64: "seed-ana", peerPubKeyB64: "peer", encKeyB64: "enc", label: "Ana", messages: [], createdAt: 1 };

beforeEach(() => {
  saveSession(ana);
  fakeEngine.update({ links: [linkView({ peerServices: [{ id: "album", type: "http", name }] })] });
});

// A 46-character name put its Open button 51 px past a 375 px phone's edge, the start of the name cut in Arabic.
describe("Services → From your contacts", () => {
  it.each(["en", "ar", "ja"] as const)("an app with a long name opens from a button no wider than the row, its name cut with an ellipsis in its own direction (%s)", async (language) => {
    renderApp(<Services />, { language });
    const open = await screen.findByTestId("contact-service-open");
    expect(open.className).toMatch(/\bmax-w-full\b/);
    expect(open.className).toMatch(/\bmin-w-0\b/);
    const label = within(open).getByTestId("contact-service-name");
    expect(label).toHaveTextContent(name);
    expect(label.className).toMatch(/\btruncate\b/);
    expect(label).toHaveAttribute("dir", "auto");
    // The verb stays whole beside the cut name, and the whole label is in the title.
    expect(open.textContent!.replace(name, "").trim()).not.toBe("");
    expect(open.getAttribute("title")).toBe(open.textContent);
  });
});

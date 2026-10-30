import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ContactLinkView } from "@ghostly/browser/shared/types";
import { ContactLinkSettings } from "../../components/requests/ContactLinkSettings";
import { renderApp } from "../render";

const CODE = "ghostly1rqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s0her5u";
const link = (patch: Partial<ContactLinkView> = {}): ContactLinkView => ({ code: CODE, link: `https://ghostly.tools/#${CODE}`, createdAt: 1, state: "open", waiting: 0, missed: 0, ...patch });

/** Settings → Profile → Contact link (WISP 8xx): make it, copy it, show its QR, make a new one, turn it off. */
describe("Contact link in Settings", () => {
  it("makes a link on request, then shows it with Copy and a QR, and says the engine looks for requests", async () => {
    const { engine, user } = renderApp(<ContactLinkSettings />);
    engine.on("createContactLink", () => { engine.update({ contactLink: link() }); return link(); });
    engine.on("contactLinkShown", () => undefined);
    expect(screen.queryByTestId("contact-link-url")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("contact-link-create"));
    expect(engine.callsTo("createContactLink")).toHaveLength(1);
    expect(await screen.findByTestId("contact-link-url")).toHaveTextContent(`https://ghostly.tools/#${CODE}`);
    await waitFor(() => expect(engine.callsTo("contactLinkShown")).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await navigator.clipboard.readText()).toBe(`https://ghostly.tools/#${CODE}`);
    expect(screen.getByTestId("contact-link-settings").querySelector("svg")).toBeInTheDocument();
  });

  it("turns off only after a second tap, and makes a new link in place of the old", async () => {
    const { engine, user } = renderApp(<ContactLinkSettings />);
    engine.on("contactLinkShown", () => undefined);
    engine.on("turnOffContactLink", () => { engine.update({ contactLink: undefined }); });
    engine.on("createContactLink", () => link());
    act(() => engine.update({ contactLink: link() }));
    await user.click(screen.getByTestId("contact-link-new"));
    expect(engine.callsTo("createContactLink")).toHaveLength(1);
    await user.click(screen.getByTestId("contact-link-off"));
    expect(engine.callsTo("turnOffContactLink")).toHaveLength(0);
    await user.click(screen.getByTestId("contact-link-off-confirm"));
    expect(engine.callsTo("turnOffContactLink")).toHaveLength(1);
    expect(await screen.findByTestId("contact-link-create")).toBeInTheDocument();
  });

  it("says when the link could not be published, and shows a refused call's words", async () => {
    const { engine, user } = renderApp(<ContactLinkSettings />);
    engine.on("contactLinkShown", () => undefined);
    engine.on("createContactLink", () => { throw new Error("You are offline"); });
    await user.click(screen.getByTestId("contact-link-create"));
    expect(await screen.findByTestId("contact-link-error")).toHaveTextContent("offline");
    act(() => engine.update({ contactLink: link({ error: "relays down" }) }));
    expect(screen.getByTestId("contact-link-publish-error")).toHaveTextContent("could not be published");
  });
});

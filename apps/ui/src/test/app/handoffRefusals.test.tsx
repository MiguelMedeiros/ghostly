import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HandoffView } from "@ghostly/browser/devices/handoff";
import { HandoffOffer } from "../../components/devices/Handoff";
import { english } from "../../lib/english";
import { LOCAL_REFUSALS, handoffProblem } from "../../lib/handoff";
import { translateWith } from "../../locales/translate";
import { LANGUAGES, LOCALES } from "../i18n/locales";
import { renderApp } from "../render";

// covers: devices.handoff

/*
 * Move to <device> and Use here said "Phone does not let this device take the profile." when this device's own engine
 * refused (no longer active, the offer gone, another move running): the other device was blamed for it.
 */

const ROOT = join(fileURLToPath(import.meta.url), "../../../../../..");
const engineSources = ["packages/browser/src/devices/handoff.ts", "packages/browser/src/engine/node.ts"].map(path => readFileSync(join(ROOT, path), "utf8")).join("\n");

describe("a move refused on this device", () => {
  it.each(Object.keys(LOCAL_REFUSALS))("%s: still thrown as it is by the engine", line => {
    expect(engineSources).toContain(`"${line}"`);
  });

  it("says what is true here, with the engine's line behind the ⓘ, and none of it blames the other device", () => {
    expect(handoffProblem(new Error("handoff-refused: Only the active device moves the profile."), english, { device: "Phone" }))
      .toEqual({ tone: "error", title: "This device is not the active one any more", detail: "Only the active device moves the profile." });
    expect(handoffProblem(new Error("handoff-refused: There is no offer to accept."), english, { device: "Phone" }))
      .toEqual({ tone: "error", title: "That offer ended", next: "Ask again from Phone.", detail: "There is no offer to accept." });
    expect(handoffProblem(new Error("handoff-busy: Another move is in progress."), english, { device: "Phone" }))
      .toEqual({ tone: "error", title: "Another move is in progress", next: "Try again when it ends.", detail: "Another move is in progress." });
    for (const line of Object.keys(LOCAL_REFUSALS)) expect(handoffProblem(new Error(line), english, { device: "Phone" })?.title).not.toContain("Phone");
  });

  it("keeps the other device's answer as the other device's", () => {
    expect(handoffProblem(new Error("handoff-refused: x"), english, { device: "Phone" })?.title).toBe("Phone does not let this device take the profile.");
    expect(handoffProblem(new Error("handoff-busy: x"), english, { device: "Phone" })?.title).toBe("Phone can't hand over the profile now. Try again later.");
    expect(handoffProblem(new Error("Something else"), english, { device: "Phone" })).toBeNull();
  });

  it.each(LANGUAGES.filter(l => l !== "en"))("reads in %s, not in English", language => {
    const t = translateWith(LOCALES[language], language);
    const same = Object.keys(LOCAL_REFUSALS).filter(line => handoffProblem(new Error(line), t, { device: "Phone" })?.title === handoffProblem(new Error(line), english, { device: "Phone" })?.title);
    expect(same).toEqual([]);
  });

  it("on a standby, Use here on an offer that ended says so and where to ask again", async () => {
    const view = { role: "taker", device: "iPhone", step: "offer", bytes: 0, total: 0, offer: 1024 } as HandoffView;
    const { user, engine } = renderApp(<HandoffOffer view={view} />);
    engine.on("deviceHandoffAccept", () => { throw new Error("handoff-refused: There is no offer to accept."); });
    await user.click(screen.getByTestId("handoff-accept"));
    const error = await screen.findByTestId("handoff-offer-error");
    expect(error).toHaveTextContent("That offer ended");
    expect(error).toHaveTextContent("Ask again from iPhone.");
    expect(error).not.toHaveTextContent("does not let this device");
  });
});

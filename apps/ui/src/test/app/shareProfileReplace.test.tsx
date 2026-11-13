import { afterEach, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { Profile } from "../../pages/Profile";
import { SharePicker } from "../../pages/SharePicker";
import { createProfile, switchProfile } from "../../lib/profiles";
import { incomingShare, receiveShare, resetIncomingShare } from "../../lib/incomingShare";
import { renderApp } from "../render";

// covers: backup.profile.same-device

/*
 * A backup restored with Replace while a share waits in the Share to… picker: the copy opens on its picker (only that
 * page is handed the share), then its profile page offers the original's removal, and the share is offered after.
 */

afterEach(() => {
  resetIncomingShare();
  vi.restoreAllMocks();
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
  location.hash = "";
});

it("a backup's Replace with a share waiting still offers the original's removal, and the share is offered after", async () => {
  const original = createProfile("Work");
  const copy = createProfile("Copy");
  receiveShare({ title: "", text: "for Ana", url: "", files: [], carry: () => true }, { queue: true });
  location.hash = "#/shared";
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  switchProfile(copy.id, { route: `/profile?replace=${original.id}` });
  vi.runAllTimers();
  vi.useRealTimers();
  expect(reload).toHaveBeenCalledOnce();
  expect(location.hash, "the next page opens where the worker hands it the share").toBe("#/shared");

  // The next page, the copy: the worker hands the share kept to its picker.
  resetIncomingShare();
  receiveShare({ title: "", text: "for Ana", url: "", files: [] }, { queue: true });
  const { user } = renderApp(
    <Routes><Route path="/shared" element={<SharePicker />} /><Route path="/profile" element={<Profile />} /></Routes>,
    { route: "/shared" },
  );
  const dialog = await screen.findByTestId("delete-profile");
  expect(dialog).toHaveTextContent("Work");
  expect(incomingShare()?.text, "the share still waits").toBe("for Ana");

  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(await screen.findByTestId("share-text")).toHaveTextContent("for Ana");
});

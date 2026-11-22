import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Root } from "../../Root";
import { fakeEngine } from "../fakeEngine";

// covers: groups.link.join

/*
 * A group's link opened in the app (`#/join/group2/…`) that the engine refuses: said as a notice in the app's words, a
 * title and what to do, not the engine's English as a bare red line that hid itself after 6 s.
 * It stays until closed, or until the next link is taken.
 */

afterEach(() => { window.location.hash = ""; });

it("a group's link opened while Ghostly is offline says so, and what to do, until it is closed", async () => {
  fakeEngine.on("joinGroupByLink", () => { throw new Error("Go online to join a group"); });
  window.location.hash = "#/join/group2/abc";
  render(<Root />);
  const notice = await screen.findByTestId("group-link-invalid");
  expect(screen.getByTestId("group-link-invalid-title")).toHaveTextContent("You are offline");
  expect(screen.getByTestId("group-link-invalid-next")).toHaveTextContent("Go online in Services, then try again.");
  expect(notice).not.toHaveTextContent("Go online to join a group");
  act(() => screen.getByTestId("group-link-invalid-close").click());
  expect(screen.queryByTestId("group-link-invalid")).toBeNull();
});

it("a refusal nothing knows keeps the engine's words behind the ⓘ", async () => {
  fakeEngine.on("joinGroupByLink", () => { throw new Error("Bad entry frame 0a1b2c3d4e5f60718293a4b5c6d7e8f9"); });
  window.location.hash = "#/join/group2/abc";
  render(<Root />);
  await screen.findByTestId("group-link-invalid");
  expect(screen.getByTestId("group-link-invalid-title")).toHaveTextContent("Something went wrong");
  act(() => screen.getByTestId("group-link-invalid-info").click());
  expect(screen.getByTestId("group-link-invalid-details")).toHaveTextContent("Bad entry frame 0a1b2c3d4e5f60718293a4b5c6d7e8f9");
});

it("a refusal goes when the next link is taken: left there, it would read as the refusal of the group that opened", async () => {
  let calls = 0;
  fakeEngine.on("joinGroupByLink", () => {
    calls += 1;
    if (calls === 1) throw new Error("Go online to join a group");
    return { groupId: "g1" };
  });
  window.location.hash = "#/join/group2/abc";
  render(<Root />);
  await screen.findByTestId("group-link-invalid");

  window.location.hash = "#/join/group2/def";
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
  await waitFor(() => expect(window.location.hash).toBe("#/group/g1"));
  expect(screen.queryByTestId("group-link-invalid")).toBeNull();
});

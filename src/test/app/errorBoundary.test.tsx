import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { renderApp } from "../render";

// covers: app.error-boundary

function Broken(): never {
  throw new Error("page exploded");
}

it("shows the page while nothing fails", () => {
  renderApp(<ErrorBoundary><p>Chats</p></ErrorBoundary>);
  expect(screen.getByText("Chats")).toBeInTheDocument();
  expect(screen.queryByTestId("app-error")).not.toBeInTheDocument();
});

it("shows a way back instead of a blank page, and starts again from home", async () => {
  // React and the boundary both report the error; the test only needs the screen.
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  location.hash = "#/chat/some-keys-in-the-address";
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  const { user } = renderApp(<ErrorBoundary><Broken /></ErrorBoundary>);

  expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong.");
  expect(logged).toHaveBeenCalledWith("Ghostly UI error", expect.objectContaining({ message: "page exploded" }), expect.any(String));
  await user.click(screen.getByRole("button", { name: "Start again" }));
  // The address that failed (it may hold keys) is not loaded again.
  expect(window.location.hash).toBe("#/");
  expect(reload).toHaveBeenCalledOnce();
});

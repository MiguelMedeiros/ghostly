import { screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentType } from "react";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { menuPage } from "../../components/MenuPage";
import { renderApp } from "../render";

// covers: app.navigation

/**
 * A page of the menu is a file of its own, fetched when the page is first opened. In the web app that request can
 * fail (the network dropped, a deploy replaced the file): the page says so in its own place, and the rest of the app,
 * the chat list and a call among it, stays on screen.
 */

const Settings = () => <h1>Settings</h1>;

/** The app as Root lays it out: the boundary around everything, the chat list beside the page. */
function app(Page: ComponentType) {
  return (
    <ErrorBoundary>
      <nav data-testid="sidebar">Chats</nav>
      <main tabIndex={-1}><Page /></main>
    </ErrorBoundary>
  );
}

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it("shows a page once its file has loaded, with nothing in its place meanwhile", async () => {
  let arrive = (_page: ComponentType) => {};
  const Page = menuPage(() => new Promise<ComponentType>((resolve) => { arrive = resolve; }));
  renderApp(app(Page));
  expect(screen.getByRole("main")).toBeEmptyDOMElement();
  arrive(Settings);
  expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
  expect(screen.queryByTestId("page-not-loaded")).not.toBeInTheDocument();
});

it("a page whose file did not load says so in its place, and the rest of the app stays", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  const Page = menuPage<object>(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
  renderApp(app(Page));

  const notice = await screen.findByTestId("page-not-loaded");
  expect(notice).toHaveAttribute("role", "alert");
  expect(notice).toHaveTextContent("This page did not load.");
  expect(screen.getByRole("main")).toContainElement(notice);
  // Not the app-wide error screen: the chat list is still there.
  expect(screen.queryByTestId("app-error")).not.toBeInTheDocument();
  expect(screen.getByTestId("sidebar")).toBeInTheDocument();
  expect(warned).toHaveBeenCalled();
});

it("Try again asks for the file again and shows the page, with the keyboard focus on the page's region", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let online = false;
  const load = vi.fn(() => (online ? Promise.resolve<ComponentType>(Settings) : Promise.reject(new TypeError("Failed to fetch"))));
  const Page = menuPage(load);
  const { user } = renderApp(app(Page));

  const again = await screen.findByRole("button", { name: "Try again" });
  // Still no network: the notice stays, and so does the focus on its button.
  await user.click(again);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("button", { name: "Try again" })).toHaveFocus();
  expect(screen.getByTestId("page-not-loaded")).toBeInTheDocument();

  online = true;
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
  expect(screen.queryByTestId("page-not-loaded")).not.toBeInTheDocument();
  expect(screen.getByRole("main")).toHaveFocus();
  expect(screen.queryByTestId("app-error")).not.toBeInTheDocument();
});

it("once Try again has failed, Reload is offered, and reloads only into a page the server answers for", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  let reachable = false;
  const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(() => (reachable ? Promise.resolve(new Response(null, { status: 200 })) : Promise.reject(new TypeError("Failed to fetch"))));
  // Chromium keeps a failed import for as long as the page lives: asking again fails however good the connection is.
  const Page = menuPage<object>(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
  const { user } = renderApp(app(Page));

  const again = await screen.findByRole("button", { name: "Try again" });
  expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
  await user.click(again);
  const button = await screen.findByRole("button", { name: "Reload" });

  // No connection: a reload would leave the browser's own error page, so the app stays.
  await user.click(button);
  await waitFor(() => expect(fetched).toHaveBeenCalledWith(location.pathname, { method: "HEAD", cache: "no-store" }));
  await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
  expect(reload).not.toHaveBeenCalled();
  expect(screen.getByTestId("sidebar")).toBeInTheDocument();

  reachable = true;
  await user.click(button);
  await waitFor(() => expect(reload).toHaveBeenCalledOnce());
});

it("the notice speaks the profile's language", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const Page = menuPage<object>(() => Promise.reject(new Error("offline")));
  renderApp(app(Page), { language: "pt" });
  expect(await screen.findByTestId("page-not-loaded")).toHaveTextContent("Esta página não carregou.");
  expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
});

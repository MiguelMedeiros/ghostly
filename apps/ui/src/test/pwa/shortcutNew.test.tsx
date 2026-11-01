import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { expect, it } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { listSessions } from "../../lib/storage";
import { renderApp } from "../render";

// covers: app.pwa.shortcuts

function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }
const openAt = (route: string) => renderApp(<UpdateProvider><Sidebar /><Routes><Route path="*" element={<Where />} /></Routes></UpdateProvider>, { route });

/** Any site can send the browser to `#/new`: the installed app's New chat shortcut opens New, and a press makes the chat. */
it("`#/new` opens New with Chat focused and makes no chat until it is pressed", async () => {
  const { user } = openAt("/new");
  const chat = within(await screen.findByTestId("sidebar-new-menu")).getAllByRole("button")[0];
  expect(chat).toHaveTextContent(/^Chat/);
  await waitFor(() => expect(chat).toHaveFocus());
  expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
  expect(listSessions()).toEqual([]);

  await user.keyboard("{Enter}");
  await waitFor(() => expect(listSessions()).toHaveLength(1));
  await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/chat/${listSessions()[0].id}`));
});

it("on the rail too, `#/new` opens New from the rail's New and makes no chat by itself", async () => {
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ chatListCollapsed: true }));
  const { user } = openAt("/new");
  expect(screen.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
  const chat = within(await screen.findByTestId("sidebar-new-menu")).getAllByRole("button")[0];
  await waitFor(() => expect(chat).toHaveFocus());
  expect(listSessions()).toEqual([]);

  await user.click(chat);
  await waitFor(() => expect(listSessions()).toHaveLength(1));
});

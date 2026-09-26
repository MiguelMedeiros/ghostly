import type { ReactElement, ReactNode } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { SettingsProvider } from "../contexts/SettingsContext";
import { I18nProvider } from "../contexts/I18nContext";
import type { Language } from "../lib/settings";
import { fakeEngine } from "./fakeEngine";

export interface AppRenderOptions extends Omit<RenderOptions, "wrapper"> {
  /** Where the router starts: a path, or a path with the state a navigation carried. */
  route?: string | { pathname: string; state?: unknown };
  /** The app's language, as the settings would hold it. */
  language?: Language;
}

/** The providers every page runs under: router, settings and translations. The engine is the fake (./fakeEngine). */
export function AppProviders({ children, route = "/" }: { children: ReactNode; route?: AppRenderOptions["route"] }) {
  return (
    <MemoryRouter initialEntries={[route]}>
      <SettingsProvider>
        <I18nProvider>{children}</I18nProvider>
      </SettingsProvider>
    </MemoryRouter>
  );
}

/** Renders `ui` inside the app's providers, with a user-event session to drive it. */
export function renderApp(ui: ReactElement, { route, language, ...options }: AppRenderOptions = {}) {
  if (language) localStorage.setItem("ghostly_app_settings", JSON.stringify({ language }));
  const user = userEvent.setup();
  const result = render(ui, { wrapper: ({ children }) => <AppProviders route={route}>{children}</AppProviders>, ...options });
  return { ...result, user, engine: fakeEngine };
}

import { HashRouter, Routes, Route } from "react-router-dom";
import { App } from "./App";
import { Home } from "./pages/Home";
import { Chat } from "./pages/Chat";
import { Settings } from "./pages/Settings";
import { ShareTab, WalletTab } from "./pages/MobileTabs";
import { SettingsProvider } from "./contexts/SettingsContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { I18nProvider } from "./contexts/I18nContext";
import { LockScreenProvider } from "./contexts/LockScreenContext";
import { LockScreen } from "./components/LockScreen";
import "./index.css";

/** The whole Ghostly UI. Desktop and Browser both render this; only the platform modules differ. */
export function Root() {
  return (
    <SettingsProvider>
      <ThemeProvider>
        <I18nProvider>
          <LockScreenProvider>
            <LockScreen />
            <HashRouter>
              <Routes>
                <Route element={<App />}>
                  <Route path="/" element={<Home />} />
                  <Route path="/chat/*" element={<Chat />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/wallet" element={<WalletTab />} />
                  <Route path="/share" element={<ShareTab />} />
                </Route>
              </Routes>
            </HashRouter>
          </LockScreenProvider>
        </I18nProvider>
      </ThemeProvider>
    </SettingsProvider>
  );
}

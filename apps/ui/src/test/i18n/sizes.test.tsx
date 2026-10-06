import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { Settings } from "../../pages/Settings";
import { byteSize } from "../../lib/backupFile";
import { formatBytes } from "../../lib/settings";
import { sizeText } from "../../lib/handoff";
import { translateWith } from "../../locales/translate";
import { LOCALES } from "./locales";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: app.i18n

const inAr = translateWith(LOCALES.ar, "ar");
const inFr = translateWith(LOCALES.fr, "fr");
const inPt = translateWith(LOCALES.pt, "pt");

describe("sizes in the app's language", () => {
  it("English reads as before", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(144 * 1024)).toBe("144 KB");
    expect(formatBytes(1.4567 * 1024 * 1024)).toBe("1.46 MB");
    expect(formatBytes(8 * 1024 ** 3)).toBe("8 GB");
    expect(byteSize(640 * 1024)).toBe("640 KB");
    expect(byteSize(12.4 * 1024 * 1024)).toBe("12.4 MB");
    expect(byteSize(20 * 1024 * 1024)).toBe("20.0 MB");
    expect(byteSize(1.3 * 1024 ** 3)).toBe("1.3 GB");
    expect(sizeText(300)).toBe("1 KB");
    expect(sizeText(480 * 1024 * 1024)).toBe("480 MB");
    expect(sizeText(1.2 * 1024 ** 3)).toBe("1.2 GB");
  });

  it("takes the language's decimal mark and unit names, in Latin digits", () => {
    expect(formatBytes(1.4567 * 1024 * 1024, inPt)).toBe("1,46 MB");
    expect(byteSize(12.4 * 1024 * 1024, inFr)).toBe("12,4 Mo");
    expect(formatBytes(1234 * 1024 * 1024, inPt)).toBe("1,21 GB");
    // Arabic: an Arabic unit, so the number is read first (a Latin "KB" came before it: "KB 144").
    expect(formatBytes(144 * 1024, inAr)).toBe("144 ك.ب");
    expect(byteSize(1.3 * 1024 ** 3, inAr)).toBe("1.3 غ.ب");
    // A move between devices (Handoff): the bytes copied, what is left for later, what a push offers.
    expect(sizeText(1.2 * 1024 ** 3, inFr)).toBe("1,2 Go");
    expect(sizeText(480 * 1024 * 1024, inPt)).toBe("480 MB");
    expect(sizeText(144 * 1024, inAr)).toBe("144 ك.ب");
  });

  it("Settings says the storage used in the app's language", async () => {
    windowIs(false);
    renderApp(<LockScreenProvider><UpdateProvider><Routes><Route path="/settings/:section?" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>,
      { route: "/settings/storage", language: "ar" });
    const used = await screen.findByTestId("settings-storage-used");
    expect(used.textContent).toMatch(/ك\.ب|م\.ب|بايت/);
    expect(used.textContent).not.toMatch(/\b(B|KB|MB|GB)\b/);
  });
});

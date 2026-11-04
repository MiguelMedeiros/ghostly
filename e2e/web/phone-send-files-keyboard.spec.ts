import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { iosKeyboard, keyboard } from "../support/keyboard";

/**
 * Send files (a picture pasted or picked in a chat) on an iPhone with the keyboard up. The sheet opens with the focus
 * in its caption, so the keyboard comes up at once. iOS keeps the page's height and only shortens what is visible
 * (e2e/support/keyboard.ts plays that here): held upright the sheet stayed centred on the whole screen, its caption and
 * Cancel/Send under the keyboard; on its side its panel cut Send and Cancel off, with nothing to scroll to them.
 */
const SCREENS = [
  { name: "an iPhone held upright", width: 390, height: 844, keyboard: 336, insets: { top: 47, bottom: 34, left: 0, right: 0 } },
  { name: "an iPhone on its side", width: 844, height: 390, keyboard: 240, insets: { top: 0, bottom: 21, left: 47, right: 47 } },
];

/** A photo as a phone takes one (taller than wide), pasted into the message field. */
function pastePhoto(page: Page): Promise<void> {
  return page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 1200;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#3a6ea5";
    g.fillRect(0, 0, 900, 1200);
    g.fillStyle = "#f2c14e";
    g.fillRect(150, 300, 600, 600);
    const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), "image/png"));
    const data = new DataTransfer();
    data.items.add(new File([blob], "IMG_0042.png", { type: "image/png" }));
    document.querySelector("textarea")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
}

/**
 * Where `locator` is drawn, whether a tap at its centre lands on it (nothing over it, not cut off by its panel), and
 * whether the picture is drawn there too (spilling out of its own part of the panel, behind the caption or a button).
 */
const placed = (locator: Locator) => locator.evaluate((element) => {
  const box = element.getBoundingClientRect();
  const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
  const hit = document.elementFromPoint(x, y);
  const picture = document.elementsFromPoint(x, y).some((under) => under.matches("[data-testid=attachment-image]"));
  return { top: Math.round(box.top), bottom: Math.round(box.bottom), tappable: !!hit && (hit === element || element.contains(hit)), picture };
});

for (const screen of SCREENS) {
  for (const language of ["en", "ar"]) {
    test(`${screen.name}, ${language}: Send files keeps its caption, Cancel and Send above the keyboard`, { tag: ["@feature:app.mobile-layout", "@feature:app.composer.paste-files"] }, async ({ peer }) => {
      const visible = screen.height - screen.keyboard;
      const { page } = await peer("send-files", { mobile: true, viewport: { width: screen.width, height: screen.height } });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: screen.insets });
      await page.evaluate((language) => {
        const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
        localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
      }, language);
      await iosKeyboard(page);
      await expect(page.locator("html")).toHaveAttribute("lang", new RegExp(`^${language}`));
      await page.getByTestId("sidebar-new-chat").filter({ visible: true }).first().click();
      await expect(page.locator("textarea")).toBeVisible();

      await pastePhoto(page);
      const sheet = page.getByTestId("attachment-sheet");
      await expect(sheet.getByTestId("attachment-image")).toBeVisible();
      const caption = sheet.getByTestId("attachment-caption");
      await expect(caption).toBeFocused();
      await keyboard(page, screen.keyboard);
      await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");

      // Each one in what the keyboard leaves, below the notch, and a tap on it reaches it.
      const report = async () => {
        const out: Record<string, string> = {};
        for (const id of ["attachment-caption", "attachment-cancel", "attachment-send"]) {
          const at = await placed(sheet.getByTestId(id));
          out[id] = at.top >= screen.insets.top - 1 && at.bottom <= visible + 1 && at.tappable && !at.picture ? "in view"
            : `${at.top}..${at.bottom} of ${screen.insets.top}..${visible}${at.tappable ? "" : ", not tappable"}${at.picture ? ", the picture drawn behind it" : ""}`;
        }
        return out;
      };
      await expect.poll(report).toEqual({ "attachment-caption": "in view", "attachment-cancel": "in view", "attachment-send": "in view" });
      await test.info().attach("keyboard up", { body: await page.screenshot({ animations: "disabled", clip: { x: 0, y: 0, width: screen.width, height: visible } }), contentType: "image/png" });

      await caption.fill(language === "ar" ? "صورة" : "a photo");
      await expect(caption).toBeFocused();
      await sheet.getByTestId("attachment-send").click();
      await expect(sheet).toHaveCount(0);
    });
  }
}

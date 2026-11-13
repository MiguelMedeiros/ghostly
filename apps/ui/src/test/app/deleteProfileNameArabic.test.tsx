import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DeleteProfileDialog } from "../../components/DeleteProfileDialog";
import { settingsKeyFor } from "../../lib/profiles";
import { renderApp } from "../render";

// covers: profiles.delete, app.i18n

/*
 * The profile's name in the Delete dialog, in Arabic: the title's its own <bdi>, the lock password's label and the
 * name-to-type placeholder (attributes, which cannot hold a <bdi>) with the name between isolate marks. Put in
 * plainly, "Work (2)" took the sentence's right-to-left direction and drew its bracket on the other side: "(Work (2".
 */

const OTHER = "abcdefghij";
const NAME = "Work (2)";

describe("the Delete dialog in Arabic isolates the profile's name", () => {
  afterEach(() => { localStorage.clear(); });

  it("in the title, the lock password's label and the name to type", () => {
    localStorage.setItem(settingsKeyFor(OTHER), JSON.stringify({ lockScreen: { enabled: true, passwordHash: "0".repeat(64), timeoutMinutes: 5 } }));
    renderApp(<DeleteProfileDialog entry={{ id: OTHER, name: NAME, createdAt: 0 }} onClose={() => {}} />, { language: "ar" });
    const title = screen.getByRole("heading", { level: 2 });
    expect(title).toHaveTextContent(`حذف «${NAME}»؟`);
    expect([...title.querySelectorAll("bdi")].map((bdi) => bdi.textContent)).toEqual([NAME]);
    expect(screen.getByTestId("delete-profile-password")).toHaveAttribute("aria-label", `كلمة مرور قفل ⁨${NAME}⁩`);
    expect(screen.getByTestId("delete-profile-confirm")).toHaveAttribute("placeholder", `اكتب ⁨${NAME}⁩`);
  });
});

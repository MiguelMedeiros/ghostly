import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Root } from "../../Root";
import { listSessions } from "../../lib/storage";

const CODE = "ghostly1rqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s0her5u";

afterEach(() => { window.location.hash = ""; });

/** A contact link opened in the app (WISP 8xx) leaves the address, makes no chat and shows the request form. */
it("a contact link in the address opens the request form, and nothing else", async () => {
  window.location.hash = `#${CODE}`;
  render(<Root />);
  expect(await screen.findByTestId("contact-ask", {}, { timeout: 10_000 })).toBeInTheDocument();
  await waitFor(() => expect(window.location.hash).not.toContain(CODE));
  expect(listSessions()).toEqual([]);
  expect(screen.queryByTestId("invite-link-invalid")).not.toBeInTheDocument();
}, 60_000);

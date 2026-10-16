import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AskedNotice } from "../../components/requests/AskedNotice";
import { renderApp } from "../render";

/** A chat made for a request through someone's contact link (WISP 8xx) says where the request is, until an answer. */
describe("the asked chat's notice", () => {
  it("says sent, arrived, turned off or no answer, and nothing once answered or for another chat", () => {
    const { engine, rerender } = renderApp(<AskedNotice linkId="asked-1" answered={false} />);
    expect(screen.queryByTestId("asked-notice")).not.toBeInTheDocument();
    for (const [state, words] of [["knocking", "Request sent"], ["seen", "Your request arrived"], ["off", "turned off"], ["ended", "No answer after seven days"]] as const) {
      act(() => engine.update({ contactAsks: [{ chatId: "asked-1", state, expires: 1 }] }));
      expect(screen.getByTestId("asked-notice")).toHaveTextContent(words);
    }
    rerender(<AskedNotice linkId="asked-1" answered />);
    expect(screen.queryByTestId("asked-notice")).not.toBeInTheDocument();
    rerender(<AskedNotice linkId="other" answered={false} />);
    expect(screen.queryByTestId("asked-notice")).not.toBeInTheDocument();
  });
});

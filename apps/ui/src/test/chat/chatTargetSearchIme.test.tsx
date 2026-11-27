import { fireEvent, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { ChatTargetSearch } from "../../components/chat/ChatTargets";
import { renderApp } from "../render";

// covers: chat.forward

/*
 * The chat pickers' search (Forward, Share, open an app in a chat) sends the down arrow on to the first chat it found.
 * While an input method composes (Japanese, Chinese…), the down arrow is the input method's: it moves among the
 * candidates, so the focus stays in the search and the composition goes on.
 */

function Picker() {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null), list = useRef<HTMLUListElement>(null);
  return <>
    <ChatTargetSearch inputRef={inputRef} list={list} value={value} onChange={setValue} testId="forward-search" />
    <ul ref={list}><li><button type="button" data-testid="first-chat">Ana</button></li></ul>
  </>;
}

describe("the chat pickers' search while an input method composes", () => {
  it("leaves the down arrow to the input method while it composes", () => {
    renderApp(<Picker />);
    const search = screen.getByTestId("forward-search");
    search.focus();
    fireEvent.compositionStart(search);
    fireEvent.keyDown(search, { key: "ArrowDown", isComposing: true, keyCode: 229 });
    expect(search).toHaveFocus();
    // WebKit and older Chrome: the key went to the input method, as 229, without `isComposing`.
    fireEvent.keyDown(search, { key: "ArrowDown", keyCode: 229 });
    expect(search).toHaveFocus();
  });

  it("goes on to the first chat once the composition ended, after the key that ended it", () => {
    renderApp(<Picker />);
    const search = screen.getByTestId("forward-search");
    search.focus();
    fireEvent.compositionStart(search);
    // WebKit's order: the composition ends first, then the keydown of the key that ended it, saying neither.
    fireEvent.compositionEnd(search, { data: "日本" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByTestId("first-chat")).toHaveFocus();
  });

  it("goes on to the first chat on a plain down arrow", () => {
    renderApp(<Picker />);
    const search = screen.getByTestId("forward-search");
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByTestId("first-chat")).toHaveFocus();
  });
});

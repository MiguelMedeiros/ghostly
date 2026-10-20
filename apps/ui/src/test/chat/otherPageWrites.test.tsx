import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useChatFolders } from "../../lib/chatFolders";
import { useChatMute } from "../../lib/chatMute";
import { useFaceChoices } from "../../components/identities/contactFace";

// covers: chats.folders

/** What another page of the app writing `key` looks like here. */
const writtenElsewhere = (key: string | null) => act(() => { window.dispatchEvent(new StorageEvent("storage", { key, newValue: key && "1" })); });

/** How many times a hook drew, for the keys other pages write. */
function draws(hook: () => unknown) {
  let n = 0;
  renderHook(() => { n++; return hook(); });
  return () => n;
}

describe("the chat list and another page's writes", () => {
  // A group open in another page writes its read mark, and every write redrew the whole list here (30 ms with 150 chats).
  it("does not redraw for a key it does not read", () => {
    const counts = [draws(() => useChatFolders()), draws(() => useChatMute("chat-a")), draws(() => useFaceChoices())];
    const before = counts.map(n => n());
    writtenElsewhere("ghostly_group_read_group-1");
    writtenElsewhere("ghostly_session_chat-a");
    expect(counts.map(n => n())).toEqual(before);
  });

  it("redraws for its own keys, and when the other page cleared everything", () => {
    const [folders, mute, faces] = [draws(() => useChatFolders()), draws(() => useChatMute("chat-a")), draws(() => useFaceChoices())];
    const at = () => [folders(), mute(), faces()];
    let before = at();
    writtenElsewhere("ghostly_chat_folders");
    expect(at()[0]).toBe(before[0] + 1);
    before = at();
    writtenElsewhere("ghostly_mute_chat-a");
    expect(at()[1]).toBe(before[1] + 1);
    before = at();
    writtenElsewhere("ghostly_face_peer");
    expect(at()[2]).toBe(before[2] + 1);
    before = at();
    writtenElsewhere(null);
    expect(at().every((n, i) => n > before[i])).toBe(true);
  });
});

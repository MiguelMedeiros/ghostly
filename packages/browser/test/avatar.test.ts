import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { GhostlyNode } from "../src/engine/node";
// covers: profiles.picture, profiles.picture.sanitize

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 128, 0, 128, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
const PICTURE = "data:image/jpeg;base64," + btoa(String.fromCharCode(...JPEG));

it("keeps this profile's picture, tells open chats at once, and refuses what is not a small JPEG", async () => {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
  const setAvatar = vi.fn();
  node["links"].set("chat", { link: { setAvatar } } as never);

  await node.updateSettings({ settings: { avatar: PICTURE } });
  expect(node["settings"].avatar).toBe(PICTURE);
  expect(setAvatar).toHaveBeenCalledWith(PICTURE);

  for (const bad of ["https://tracker.example/me.jpg", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/jpeg;base64," + btoa("nope")])
    await expect(node.updateSettings({ settings: { avatar: bad } }), bad).rejects.toThrow("small JPEG");
  expect(node["settings"].avatar, "a refused picture changes nothing").toBe(PICTURE);

  await node.updateSettings({ settings: { avatar: "" } });
  expect(node["settings"].avatar).toBeUndefined();
  expect(setAvatar).toHaveBeenLastCalledWith(undefined);
});

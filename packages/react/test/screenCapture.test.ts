import { describe, expect, it, vi } from "vitest";
import { captureScreen, SCREEN_WITH_SOUND } from "../src/screenCapture";

/** `captureScreen`: a share asks for its sound, and a browser that refuses the sound's options gets the picture alone. */

const stream = {} as MediaStream;
const refused = (name: string) => Object.assign(new Error(name), { name });

describe("captureScreen", () => {
  it("asks for the picture and its sound, without this page's own playback", async () => {
    const getDisplayMedia = vi.fn(async () => stream);
    await expect(captureScreen(getDisplayMedia)).resolves.toBe(stream);
    expect(getDisplayMedia).toHaveBeenCalledExactlyOnceWith({ video: true, audio: { restrictOwnAudio: true }, systemAudio: "include" });
  });

  it.each(["TypeError", "NotSupportedError", "OverconstrainedError"])("a %s, before any picker, is asked again for the picture alone", async (name) => {
    const getDisplayMedia = vi.fn<(options: DisplayMediaStreamOptions) => Promise<MediaStream>>().mockRejectedValueOnce(refused(name)).mockResolvedValueOnce(stream);
    await expect(captureScreen(getDisplayMedia)).resolves.toBe(stream);
    expect(getDisplayMedia.mock.calls).toEqual([[SCREEN_WITH_SOUND], [{ video: true, audio: false }]]);
  });

  it.each(["NotAllowedError", "AbortError", "NotFoundError"])("a %s (the picker closed, the system's refusal) is thrown as it came, the picker not opened again", async (name) => {
    const getDisplayMedia = vi.fn(async () => { throw refused(name); });
    await expect(captureScreen(getDisplayMedia)).rejects.toMatchObject({ name });
    expect(getDisplayMedia).toHaveBeenCalledOnce();
  });

  it("its options cannot be changed by a caller for the next share", () => {
    expect(Object.isFrozen(SCREEN_WITH_SOUND)).toBe(true);
    expect(Object.isFrozen(SCREEN_WITH_SOUND.audio)).toBe(true);
  });
});

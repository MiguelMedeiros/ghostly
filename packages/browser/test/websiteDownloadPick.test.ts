import { describe, expect, it } from "vitest";
import { defaultInstaller } from "../../../apps/website/lib/release";

/*
 * The download panel of ghostly.tools marks one installer as the reader's (apps/website/lib/release.ts, read by
 * components/home/Finale.tsx). A phone or a tablet gets none: there is no Ghostly installer for it, so the browser
 * button leads. Safari on an iPad asks for the desktop site and sends a Mac's strings, and only its touch points tell
 * it from a Mac: a Mac reports 0, an iPad 5.
 */

const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

describe("website download pick", () => {
  it("marks no installer on an iPad, whose Safari sends a Mac's strings", () => {
    expect(defaultInstaller(MAC_SAFARI, "MacIntel", undefined, 5)).toBeUndefined();
  });

  it("marks the Mac installer on a Mac, which has no touch points", () => {
    expect(defaultInstaller(MAC_SAFARI, "MacIntel", undefined, 0)).toBe("macArm");
    expect(defaultInstaller(MAC_SAFARI, "MacIntel")).toBe("macArm");
    expect(defaultInstaller(MAC_SAFARI, "MacIntel", "x86", 0)).toBe("macIntel");
  });

  it("marks no installer on a phone", () => {
    expect(defaultInstaller(IPHONE, "iPhone", undefined, 5)).toBeUndefined();
    expect(defaultInstaller(ANDROID, "Linux armv81", undefined, 5)).toBeUndefined();
  });

  it("keeps the Windows installer on a Windows machine with a touch screen", () => {
    expect(defaultInstaller(WINDOWS, "Win32", undefined, 10)).toBe("windowsExe");
  });
});

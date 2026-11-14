"use client";

import { useEffect, useState } from "react";
import { defaultInstaller, type InstallerKey } from "./release";

/**
 * The installer for the reader's machine (defaultInstaller), once React runs:
 * undefined on the server and when it cannot tell. Chrome on a Mac says whether
 * it is Apple silicon; an iPad looks like a Mac but for its touch points.
 */
export function useInstaller(): InstallerKey | undefined {
  const [installer, setInstaller] = useState<InstallerKey | undefined>(undefined);
  useEffect(() => {
    const nav = navigator as Navigator & {
      userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }> };
    };
    let cancelled = false;
    const guess = defaultInstaller(nav.userAgent, nav.platform, undefined, nav.maxTouchPoints);
    setInstaller(guess);
    if (guess === "macArm" && nav.userAgentData) {
      nav.userAgentData
        .getHighEntropyValues(["architecture"])
        .then((v) => {
          if (!cancelled) setInstaller(defaultInstaller(nav.userAgent, nav.platform, v.architecture));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, []);
  return installer;
}

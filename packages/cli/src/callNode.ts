import { MAX_GROUP_CALL_SFU, groupCallSfu } from "@ghostly/core";

/**
 * Why `raw` is no call node for a group (WISP 602: an https origin in its one spelling, `groupCallSfu`), told from the
 * value alone: no https origin at all, an https origin past the limit, or one in another spelling (a path, a trailing
 * `/`, capitals, `:443`), whose one spelling is `origin`. Undefined for a call node. `group call --sfu` says the first
 * two as a usage error before the profile opens; the API says all three, the third with the group's own reference.
 */
export function callNodeProblem(raw: string): { problem: "origin" } | { problem: "long" } | { problem: "spelling"; origin: string } | undefined {
  if (groupCallSfu(raw)) return undefined;
  let origin: string | undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") origin = url.origin;
  } catch { /* no URL at all */ }
  if (!origin) return { problem: "origin" };
  if (origin.length > MAX_GROUP_CALL_SFU) return { problem: "long" };
  return { problem: "spelling", origin };
}

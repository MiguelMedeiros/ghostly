import type { LinkView } from "@ghostly/browser/shared/types";

/**
 * How far a paired chat's first connection got, as the engine reports it per chat (`PairingProgress` in
 * @ghostly/core). The inviter publishes the invite and waits; the joiner looks the invite up and knocks in its
 * first packet; the inviter answers; both connect and go live.
 */
export type { PairingProgress, PairingRole, PairingStage } from "@ghostly/core";
import type { PairingProgress, PairingRole, PairingStage } from "@ghostly/core";

/** The steps each side walks through, in order. `failed` can replace any of them. */
export const PAIRING_STEPS: Record<PairingRole, PairingStage[]> = {
  inviter: ["publishing", "waiting", "answering", "connecting", "live"],
  joiner: ["resolving", "knocking", "answering", "connecting", "live"],
};

/**
 * Where a stage stands in its role's steps, or -1 for one that is not a step (`failed`, `on-dht`). Either side can be at
 * either side's handshake stage (an inviter whose contact never knocks knocks itself, after a grace), and an inviter
 * whose contact was seen is past its wait: both are its handshake step, so a stage never reads as no step at all.
 */
export function stepIndex(role: PairingRole, stage: PairingStage, peerSeen?: boolean): number {
  const steps = PAIRING_STEPS[role];
  if (stage === "failed" || stage === "on-dht") return -1;
  if (role === "inviter" && (stage === "knocking" || (stage === "waiting" && peerSeen))) return steps.indexOf("answering");
  if (role === "joiner" && stage === "waiting") return steps.indexOf("knocking");
  if (role === "inviter" && stage === "resolving") return steps.indexOf("publishing");
  return steps.indexOf(stage);
}

/**
 * What the scene and the header show of a pairing: the furthest step reached, never one back. An attempt that fails
 * takes the engine back between attempts (`waiting`, `resolving`), and a quick handshake can come in any order; the
 * step stays where it got to, and the words say that step until the pairing moves past it, with the attempt count
 * telling that it is tried again. `reached` is the furthest step seen so far (-1 for none).
 */
export function pairingView(role: PairingRole, stage: PairingStage, peerSeen: boolean | undefined, reached: number): { stage: PairingStage; step: number } {
  const index = stepIndex(role, stage, peerSeen);
  if (index < 0) return { stage, step: reached };
  if (index >= reached) return { stage, step: index };
  return { stage: PAIRING_STEPS[role][reached], step: reached };
}

/**
 * After this long in a stage the scene says in words what is still going on. Waiting for a person to open the
 * invite is normal for minutes; the network steps are not.
 */
export const SLOW_AFTER_MS: Record<PairingStage, number> = {
  publishing: 8_000,
  waiting: 120_000,
  resolving: 10_000,
  knocking: 12_000,
  answering: 10_000,
  connecting: 12_000,
  live: Infinity,
  "on-dht": Infinity,
  failed: Infinity,
};

/** Failure codes with words of their own; anything else reads as `unknown`, with `detail` under it. */
export const FAILURE_REASONS = ["publish", "resolve", "timeout", "offline", "transport", "rejected", "keyMismatch", "expired", "taken"] as const;
export type FailureReason = typeof FAILURE_REASONS[number] | "unknown";

export function failureReason(code: string | undefined): FailureReason {
  const camel = (code ?? "").replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  return (FAILURE_REASONS as readonly string[]).includes(camel) ? camel as FailureReason : "unknown";
}

/** The engine's own report of a chat's first pairing (`LinkView.pairingProgress`), when it gives one. */
export function reportedProgress(link: LinkView | undefined): PairingProgress | undefined {
  return link?.pairingProgress;
}

/**
 * The stage as it can be read off what the engine already shows about a link, for engines that do not report
 * progress yet. `link` is absent while a chat just joined is still being set up.
 */
export function deriveStage(link: LinkView | undefined, role: PairingRole, online: boolean): Pick<PairingProgress, "stage" | "detail" | "reason" | "retryable"> {
  // Offline is this device's own switch: nothing to retry, pairing goes on once it is back.
  if (!online) return { stage: "failed", reason: "offline", retryable: false };
  if (!link) return { stage: role === "inviter" ? "publishing" : "resolving" };
  const pair = link.pairing;
  if (pair?.keyMismatch) return { stage: "failed", reason: "key-mismatch", retryable: false };
  if (pair?.status === "error") return { stage: "failed", reason: "transport", retryable: true, detail: pair.error };
  if (pair?.status === "ready" && link.dataLink === "open") return { stage: "live" };
  // Discovery errors are retried by the engine on its own: the stage goes on, slow, with the error as its detail.
  const detail = link.discoveryError || undefined;
  if (role === "inviter" && link.discoveryError?.startsWith("Could not publish discovery:") && !link.peerOnline && !pair?.peerKey) return { stage: "publishing", detail };
  if (link.dataLink === "connecting" || link.dataLink === "open" || pair?.status === "negotiating" || pair?.status === "confirm" || (pair?.status === "waiting" && !!pair.peerKey)) return { stage: "connecting", detail };
  if (link.dataLink === "offering" || link.dataLink === "answering") return { stage: "answering", detail };
  if (role === "inviter") {
    if (link.peerOnline || pair?.peerKey) return { stage: "answering", detail };
    // `offline` is a link the engine has not started yet (a new chat still being saved): nothing is published.
    return { stage: link.status === "connecting" || link.status === "offline" ? "publishing" : "waiting", detail };
  }
  return { stage: link.peerOnline ? "knocking" : "resolving", detail };
}

/** The stages past the inviter's wait: the contact came with the invite and the two are pairing, or paired. */
const CONTACT_ARRIVED: PairingStage[] = ["answering", "connecting", "live", "on-dht"];

/**
 * The contact has the invite and is using it: their packet was seen (`peerSeen`), or the pairing is past the
 * inviter's wait. The inviter's invite card goes then, and the scene alone tells the rest.
 *
 * Read off the state each time, not latched: when the state goes back to "nobody seen" (an engine that reports no
 * progress, whose contact went offline; or a restarted engine, before the contact's packet is seen again), the
 * card comes back. An attempt that fails after the contact was seen keeps `peerSeen` (the engine's tracker never
 * clears it), so the card does not come back just because an attempt is retried: the contact still has the invite.
 */
export function contactArrived(progress: Pick<PairingProgress, "stage" | "peerSeen"> | null | undefined): boolean {
  return !!progress && (!!progress.peerSeen || CONTACT_ARRIVED.includes(progress.stage));
}

/** `m:ss`, or `h:mm:ss` past the hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

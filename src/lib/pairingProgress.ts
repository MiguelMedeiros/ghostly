import type { LinkView } from "@ghostly/browser/shared/types";

/**
 * How far a paired chat's first connection got, as the engine reports it per chat (the contract shared with the
 * pairing-speed work). The inviter publishes the invite and waits for the knock; the joiner looks the invite up
 * and knocks; both then answer, connect and go live.
 */
export type PairingStage = "publishing" | "waiting" | "resolving" | "knocking" | "answering" | "connecting" | "live" | "failed";
export type PairingRole = "inviter" | "joiner";

export interface PairingProgress {
  role: PairingRole;
  stage: PairingStage;
  /** When this stage began (ms since the epoch). */
  since: number;
  /** When this pairing began. */
  startedAt: number;
  /** 1 for the first try; a retry counts up. */
  attempt: number;
  /** A short technical note (an error message, a relay), shown under the plain words. */
  detail?: string;
  /** Only when `stage` is `failed`: a short code, and whether trying again can help. */
  reason?: string;
  retryable?: boolean;
}

/** The steps each side walks through, in order. `failed` can replace any of them. */
export const PAIRING_STEPS: Record<PairingRole, PairingStage[]> = {
  inviter: ["publishing", "waiting", "answering", "connecting", "live"],
  joiner: ["resolving", "knocking", "answering", "connecting", "live"],
};

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
  failed: Infinity,
};

/** Failure codes with words of their own; anything else reads as `unknown`, with `detail` under it. */
export const FAILURE_REASONS = ["publish", "resolve", "timeout", "offline", "transport", "rejected", "keyMismatch", "expired"] as const;
export type FailureReason = typeof FAILURE_REASONS[number] | "unknown";

export function failureReason(code: string | undefined): FailureReason {
  const camel = (code ?? "").replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  return (FAILURE_REASONS as readonly string[]).includes(camel) ? camel as FailureReason : "unknown";
}

/** The engine's own report, when it gives one (the field lands with the pairing-speed work). */
export function reportedProgress(link: LinkView | undefined): PairingProgress | undefined {
  const reported = (link as (LinkView & { pairingProgress?: PairingProgress }) | undefined)?.pairingProgress;
  return reported && typeof reported.stage === "string" && typeof reported.role === "string" ? reported : undefined;
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
    return { stage: link.status === "connecting" ? "publishing" : "waiting", detail };
  }
  return { stage: link.peerOnline ? "knocking" : "resolving", detail };
}

/** `m:ss`, or `h:mm:ss` past the hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

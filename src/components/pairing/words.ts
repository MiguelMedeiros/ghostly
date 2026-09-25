import { useI18n } from "../../contexts/I18nContext";
import type { FailureReason, PairingRole, PairingStage } from "../../lib/pairingProgress";

/** The plain words for each stage, step, slow stage and failure, in the person's language. */
export function usePairingWords() {
  const { t } = useI18n();
  return {
    /** A sentence for where the pairing is. `answering` reads differently on each side. */
    stage: (stage: PairingStage, role: PairingRole) => {
      switch (stage) {
        case "publishing": return t("pairing.stage.publishing");
        case "waiting": return t("pairing.stage.waiting");
        case "resolving": return t("pairing.stage.resolving");
        case "knocking": return t("pairing.stage.knocking");
        case "answering": return role === "inviter" ? t("pairing.stage.answeringInviter") : t("pairing.stage.answeringJoiner");
        case "connecting": return t("pairing.stage.connecting");
        case "live": return t("pairing.stage.live");
        case "on-dht": return t("pairing.stage.onDht");
        case "failed": return t("pairing.stage.failed");
      }
    },
    /** One or two words, for the step list and the header. */
    step: (stage: PairingStage) => {
      switch (stage) {
        case "publishing": return t("pairing.step.publishing");
        case "waiting": return t("pairing.step.waiting");
        case "resolving": return t("pairing.step.resolving");
        case "knocking": return t("pairing.step.knocking");
        case "answering": return t("pairing.step.answering");
        case "connecting": return t("pairing.step.connecting");
        case "live": return t("pairing.step.live");
        case "on-dht": return t("pairing.step.onDht");
        case "failed": return t("pairing.step.failed");
      }
    },
    /** What is still going on, once a stage takes longer than it should. */
    slow: (stage: PairingStage) => {
      switch (stage) {
        case "publishing": return t("pairing.slow.publishing");
        case "waiting": return t("pairing.slow.waiting");
        case "resolving": return t("pairing.slow.resolving");
        case "knocking": return t("pairing.slow.knocking");
        case "answering": return t("pairing.slow.answering");
        case "connecting": return t("pairing.slow.connecting");
        default: return "";
      }
    },
    /** Why the chat is on the DHT (WISP 400): no common transport, attempts failed, DHT only chosen, or still trying. */
    onDht: (reason: string | undefined) => {
      switch (reason) {
        case "no-common-transport": return t("pairing.onDht.noCommonTransport");
        case "transport": return t("pairing.onDht.transport");
        case "chosen": return t("pairing.onDht.chosen");
        default: return t("pairing.onDht.waiting");
      }
    },
    reason: (reason: FailureReason) => {
      switch (reason) {
        case "publish": return t("pairing.reason.publish");
        case "resolve": return t("pairing.reason.resolve");
        case "timeout": return t("pairing.reason.timeout");
        case "offline": return t("pairing.reason.offline");
        case "transport": return t("pairing.reason.transport");
        case "rejected": return t("pairing.reason.rejected");
        case "keyMismatch": return t("pairing.reason.keyMismatch");
        case "expired": return t("pairing.reason.expired");
        case "unknown": return t("pairing.reason.unknown");
      }
    },
  };
}

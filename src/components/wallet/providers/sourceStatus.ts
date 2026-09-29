import type { SourceView } from "@ghostly/browser/engine/paymentAdapters/providers/sources";
import type { ProviderField } from "@ghostly/browser/engine/paymentAdapters/providers/types";
import type { Translate } from "../../../contexts/I18nContext";

type Key = Parameters<Translate>[0];
const STATUS: Record<SourceView["status"], Key> = {
  none: "wallet.source.status.none",
  connecting: "wallet.source.status.connecting",
  ready: "wallet.source.status.ready",
  error: "wallet.source.status.error",
};

/** The source's line under its name: connected, reconnecting after a failure (and why), or unavailable. */
export function sourceStatus(t: Translate, view: SourceView): string {
  if (view.status === "connecting" && view.failures) return t("wallet.source.status.reconnecting", { error: view.error ?? t("wallet.source.status.noAnswer") });
  if (view.status === "error" && view.error) return view.retryAt ? t("wallet.source.status.retrying", { error: view.error }) : view.error;
  return view.error ?? [t(STATUS[view.status]), view.alias, view.network && view.network !== "bitcoin" ? view.network : undefined, view.custodial ? t("wallet.source.status.custodial") : undefined].filter(Boolean).join(" · ");
}

/** Whether a saved source has a server that "Change server" can edit. */
export const changeableFields = (view: SourceView): ProviderField[] =>
  view.providerId && !view.isDefault ? view.offered.find((d) => d.id === view.providerId)?.fields.filter((f) => f.changeable) ?? [] : [];

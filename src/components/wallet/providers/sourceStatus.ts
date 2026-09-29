import type { SourceView } from "@ghostly/browser/engine/paymentAdapters/providers/sources";
import type { ProviderField } from "@ghostly/browser/engine/paymentAdapters/providers/types";

const STATUS = { none: "Not set up", connecting: "Connecting…", ready: "Connected", error: "Not connected" } as const;

/** The source's line under its name: connected, reconnecting after a failure (and why), or unavailable. */
export function sourceStatus(view: SourceView): string {
  if (view.status === "connecting" && view.failures) return `Connecting… · ${view.error ?? "no answer yet"} · trying again by itself`;
  if (view.status === "error" && view.error) return view.retryAt ? `${view.error} · trying again by itself` : view.error;
  return view.error ?? [STATUS[view.status], view.alias, view.network && view.network !== "bitcoin" ? view.network : undefined, view.custodial ? "custodial" : undefined].filter(Boolean).join(" · ");
}

/** Whether a saved source has a server that "Change server" can edit. */
export const changeableFields = (view: SourceView): ProviderField[] =>
  view.providerId && !view.isDefault ? view.offered.find((d) => d.id === view.providerId)?.fields.filter((f) => f.changeable) ?? [] : [];

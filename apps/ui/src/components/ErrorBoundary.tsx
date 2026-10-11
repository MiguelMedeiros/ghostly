import { Component, type ErrorInfo, type ReactNode } from "react";
import { useT } from "../contexts/I18nContext";

/**
 * The last line: an error nothing else caught shows a way back instead of a blank page. Going back
 * starts from home, so an address that caused it (it may hold keys) is not loaded again.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Ghostly UI error", error, info.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <ErrorScreen />;
  }
}

/** The screen itself: a function, so it reads the profile's translator (the boundary is a class); English with no provider. */
function ErrorScreen() {
  const t = useT();
  return (
    <div role="alert" data-testid="app-error" className="h-dvh grid place-items-center bg-chat-bg p-6 text-center">
      <div className="space-y-3">
        <p className="text-text-primary">{t("errors.generic")}</p>
        <button type="button" onClick={() => { history.replaceState(null, "", "#/"); location.reload(); }}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-accent text-on-accent hover:bg-accent-hover cursor-pointer">{t("errors.startAgain")}</button>
      </div>
    </div>
  );
}

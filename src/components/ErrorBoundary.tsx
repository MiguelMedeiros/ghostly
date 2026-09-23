import { Component, type ErrorInfo, type ReactNode } from "react";

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
    return (
      <div role="alert" data-testid="app-error" className="h-dvh grid place-items-center bg-chat-bg p-6 text-center">
        <div className="space-y-3">
          <p className="text-text-primary">Something went wrong.</p>
          <button type="button" onClick={() => { history.replaceState(null, "", "#/"); location.reload(); }}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-accent text-[#111b21] hover:bg-accent-hover cursor-pointer">Start again</button>
        </div>
      </div>
    );
  }
}

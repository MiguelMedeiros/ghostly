import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

const WIDTH = { md: "max-w-2xl", lg: "max-w-3xl" } as const;

/**
 * A page of the right-hand column (Wallet, Services, Settings, Profile): a header with the way back, and a
 * scrolling body. The body is a size container (`@container/page`), so anything inside can ask how wide the
 * column is (`@sm/page:`, `@md/page:`) instead of how wide the window is: on a desktop the column can be
 * as narrow as a phone.
 */
export function Page({ title, trailing, width = "lg", testId, children }: {
  title: ReactNode;
  /** Controls at the end of the header (a switch, a toggle). They move under the title when the column is narrow. */
  trailing?: ReactNode;
  width?: keyof typeof WIDTH;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex-1 flex flex-col bg-chat-bg overflow-hidden min-h-0 min-w-0" data-testid={testId}>
      <PageHeader title={title} trailing={trailing} />
      <div className="@container/page flex-1 overflow-y-auto overflow-x-hidden px-6 py-6 max-md:px-4 max-md:py-4" data-page-body>
        <div className={`${WIDTH[width]} mx-auto space-y-6`}>{children}</div>
      </div>
    </div>
  );
}

/**
 * Back, title, and the page's own controls. The row wraps: when the title and the controls do not fit side
 * by side, the controls go on a second line instead of pushing out of the bar.
 */
export function PageHeader({ title, trailing }: { title: ReactNode; trailing?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <header className="page-header shrink-0 bg-panel-header border-b border-border flex flex-wrap items-center gap-x-3 gap-y-2 px-4">
      <div className="flex items-center gap-1 min-w-0 flex-[1_1_auto]">
        <button type="button" onClick={() => navigate(-1)} aria-label="Back" className="max-md:hidden -ml-2 grid place-items-center w-10 h-10 shrink-0 rounded-full hover:bg-surface-hover transition-colors cursor-pointer">
          <svg className="w-5 h-5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        </button>
        <h1 className="text-lg font-medium text-text-primary truncate">{title}</h1>
      </div>
      {trailing && <div className="flex items-center gap-2 shrink-0 max-w-full ml-auto">{trailing}</div>}
    </header>
  );
}

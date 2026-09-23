import type { ReactNode } from "react";

/**
 * Buttons side by side that wrap onto a new line instead of overflowing. `fill`: each one takes an equal
 * share of the line (Pay / Cancel under a form).
 */
export function ButtonGroup({ children, fill, className = "" }: { children: ReactNode; fill?: boolean; className?: string }) {
  return <div className={`flex flex-wrap items-center gap-2 ${fill ? "*:flex-[1_1_8rem]" : ""} ${className}`}>{children}</div>;
}

/**
 * A field and its button on one line (a URL and "Add", a passphrase and "Restore"). The field keeps at
 * least 12rem; below that the buttons go under it. Put it around a `<form>`'s contents or use `as="form"`.
 */
export function InputGroup({ children, as: Tag = "div", onSubmit, className = "" }: { children: ReactNode; as?: "div" | "form"; onSubmit?: React.FormEventHandler<HTMLFormElement>; className?: string }) {
  const classes = `flex flex-wrap items-center gap-2 *:min-w-0 [&>input]:flex-[1_1_12rem] [&>select]:flex-[1_1_12rem] [&>textarea]:flex-[1_1_12rem] [&>button]:shrink-0 ${className}`;
  return Tag === "form" ? <form className={classes} onSubmit={onSubmit}>{children}</form> : <div className={classes}>{children}</div>;
}

/**
 * Fields (or option cards) in a grid: as many columns as fit at `min` each, at most `max`, one column
 * below that. The gap is 0.5rem.
 */
export function FieldGrid({ children, min = "12rem", max = 2 }: { children: ReactNode; min?: string; max?: number }) {
  const cap = `(100% - ${max - 1} * 0.5rem) / ${max}`;
  return <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(max(min(100%, ${min}), ${cap}), 1fr))` }}>{children}</div>;
}

/** A long single-line value (a URL, a host) cut with an ellipsis; the whole of it is in the tooltip. */
export function Truncate({ children, title, className = "" }: { children: string; title?: string; className?: string }) {
  return <span className={`block truncate ${className}`} title={title ?? children}>{children}</span>;
}

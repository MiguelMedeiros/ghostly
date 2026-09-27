"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";

export type WispNavGroup = {
  id: string;
  title: string;
  items: { id: string; slug: string; number: string; name: string; child: boolean; assigned: boolean }[];
};

type Copy = { all: string; expandAll: string; collapseAll: string };

/**
 * What the visitor opened and closed, by group id. The group of the draft being read is open on arrival
 * whatever is stored, so the stored choice speaks for the other groups.
 */
const KEY = "ghostly.reader.groups";
const listeners = new Set<() => void>();
// The page works the same where storage is refused (private windows, blocked site data): the choice then
// lasts as long as the page.
let memory = "{}";

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

function write(choices: Record<string, boolean>) {
  memory = JSON.stringify(choices);
  try {
    localStorage.setItem(KEY, memory);
  } catch {
    // Kept in memory only.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    removeEventListener("storage", listener);
  };
}

function parse(raw: string): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, open]) => typeof open === "boolean")) as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function WispNav({ groups, current, t }: { groups: WispNavGroup[]; current?: string; t: Copy }) {
  // The server (and the first client render) knows no stored choice: only the current group is open.
  const choices = parse(useSyncExternalStore(subscribe, read, () => "{}"));
  const currentGroup = groups.find((g) => g.items.some((x) => x.slug === current))?.id;
  // The current group can be closed while reading this draft; the next draft opens its own group again.
  const [closedAt, setClosedAt] = useState<string | undefined>();
  const nav = useRef<HTMLElement>(null);

  const isOpen = (id: string) => (id === currentGroup ? closedAt !== current : (choices[id] ?? false));
  const allOpen = groups.every((g) => isOpen(g.id));

  const set = (ids: string[], open: boolean) => {
    if (currentGroup && ids.includes(currentGroup)) setClosedAt(open ? undefined : current);
    write({ ...choices, ...Object.fromEntries(ids.map((id) => [id, open])) });
  };

  // The current draft in sight inside the sidebar's own scroll, without moving the page.
  useEffect(() => {
    const link = nav.current?.querySelector<HTMLElement>('a[aria-current="page"]');
    const side = link?.closest<HTMLElement>(".reader-side");
    if (!link || !side || side.scrollHeight <= side.clientHeight) return;
    const box = side.getBoundingClientRect();
    const at = link.getBoundingClientRect();
    if (at.top >= box.top && at.bottom <= box.bottom) return;
    side.scrollTop += at.top - box.top - (box.height - at.height) / 2;
  }, [current]);

  return (
    <div className="reader-all">
      <div className="reader-all-head">
        <p>{t.all}</p>
        <button type="button" className="reader-all-toggle" data-testid="reader-groups-all" onClick={() => set(groups.map((g) => g.id), !allOpen)}>
          {allOpen ? t.collapseAll : t.expandAll}
        </button>
      </div>
      <nav aria-label={t.all} ref={nav}>
        {groups.map((g) => {
          const open = isOpen(g.id);
          const panel = `reader-group-${g.id}`;
          return (
            <div key={g.id} className="reader-all-group" data-group={g.id} data-open={open}>
              <button type="button" className="reader-group-head" aria-expanded={open} aria-controls={panel} onClick={() => set([g.id], !open)}>
                <svg className="reader-group-chevron" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                  <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>{g.title}</span>
                <span className="reader-group-count mono">{g.items.length}</span>
              </button>
              <div className="reader-group-panel" id={panel}>
                <ul>
                  {g.items.map((x) => (
                    <li key={x.id} data-child={x.child} data-assigned={x.assigned}>
                      <Link href={`/developers/wisps/${x.slug}`} aria-current={x.slug === current ? "page" : undefined}>
                        <span className="mono">{x.number}</span>
                        {x.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        })}
      </nav>
    </div>
  );
}

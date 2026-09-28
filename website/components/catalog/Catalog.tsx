"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/site/icons";
import { LevelBadge } from "@/components/site/Level";
import { LEVELS, type Level } from "@/lib/status";
import type { GroupId } from "@/lib/wisps";
import type { CatalogCopy } from "@/content/catalog";
import { shell } from "@/content/shell";

export type CatalogRow = {
  id: string;
  number: string;
  assigned: boolean;
  kind: string;
  slug: string;
  name: string;
  group: GroupId;
  parent?: string;
  status: string;
  benefit?: string;
  note?: string;
  implementation?: string;
  level: Level | null;
  legacyIds: string[];
};

export type CatalogGroup = { id: GroupId; title: string; blurb: string; icon: string };

const KINDS = ["Contract", "Adapter", "Profile", "Process"];

/**
 * Search and the full list, laid out like a WISP's own page: the controls sit in the reader's side column
 * (families with their counts, as in its "All drafts" list), and each draft reads like a small reader header.
 */
export function Catalog({ rows, groups, t }: { rows: CatalogRow[]; groups: CatalogGroup[]; t: CatalogCopy }) {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<GroupId | "all">("all");
  const [kind, setKind] = useState<string>("all");
  const [level, setLevel] = useState<Level | "all">("all");

  // A link to #wisp-401 should land on that row even if filters were active.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);

  // Everything but the family: the family list counts what each family would show.
  const matching = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (kind !== "all" && r.kind !== kind) return false;
      if (level !== "all" && r.level !== level) return false;
      if (!needle) return true;
      return [r.number, r.id, r.name, r.benefit, r.note, r.implementation, r.slug].some((s) => s?.toLowerCase().includes(needle));
    });
  }, [rows, q, kind, level]);
  const shown = group === "all" ? matching : matching.filter((r) => r.group === group);

  const filtered = q || group !== "all" || kind !== "all" || level !== "all";
  const clear = () => {
    setQ("");
    setGroup("all");
    setKind("all");
    setLevel("all");
  };

  return (
    <div className="reader-layout catalog">
      {/* First in the page so that on one column the title leads; on two it sits over the list. */}
      <header className="reader-head catalog-head">
        <h2 className="catalog-list-title" id="list-title">
          {t.listTitle}
        </h2>
        <p className="reader-scope">
          <span className="chip">Draft</span> {t.axes}
        </p>
      </header>

      <aside className="reader-side catalog-side">
        <label className="catalog-search">
          <Icon name="search" />
          <span className="sr-only">{t.searchLabel}</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.search} />
        </label>
        <p className="catalog-count mono" aria-live="polite">
          {t.results.replace("{n}", String(shown.length)).replace("{t}", String(rows.length))}
        </p>

        <div className="reader-all catalog-families">
          <div className="reader-all-head">
            <p id="catalog-family-label">{t.family}</p>
            {filtered && (
              <button type="button" className="reader-all-toggle catalog-clear" onClick={clear}>
                {t.clear}
              </button>
            )}
          </div>
          <ul aria-labelledby="catalog-family-label">
            <li>
              <button type="button" className="reader-group-head catalog-family" aria-pressed={group === "all"} onClick={() => setGroup("all")}>
                <span>{t.all}</span>
                <span className="reader-group-count mono">{matching.length}</span>
              </button>
            </li>
            {groups.map((g) => {
              const n = matching.filter((r) => r.group === g.id).length;
              return (
                <li key={g.id}>
                  <button
                    type="button"
                    className="reader-group-head catalog-family"
                    aria-pressed={group === g.id}
                    data-empty={n === 0}
                    onClick={() => setGroup(group === g.id ? "all" : g.id)}
                  >
                    <Icon name={g.icon} />
                    <span>{g.title}</span>
                    <span className="reader-group-count mono">{n}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="catalog-filters">
          <label>
            <span>{t.kind}</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="all">{t.all}</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t.kinds[k] ?? k}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t.level}</span>
            <select value={level} onChange={(e) => setLevel(e.target.value as Level | "all")}>
              <option value="all">{t.all}</option>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {shell.levels[l]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </aside>

      <div className="reader-main catalog-main">
        {shown.length === 0 && <p className="catalog-none">{t.none}</p>}

        {groups.map((g) => {
          const items = shown.filter((r) => r.group === g.id);
          if (!items.length) return null;
          return (
            <section key={g.id} className="catalog-group" id={`family-${g.id}`} aria-labelledby={`family-${g.id}-title`}>
              <header className="catalog-group-head">
                <h2 id={`family-${g.id}-title`}>
                  <Icon name={g.icon} />
                  {g.title}
                </h2>
                <p className="reader-note">{g.blurb}</p>
              </header>
              <ul className="catalog-list">
                {items.map((r) => (
                  <li key={r.id} id={`wisp-${r.id}`} className="catalog-row" data-child={Boolean(r.parent)}>
                    {r.legacyIds.map((old) => (
                      <span key={old} id={`wisp-${old}`} className="anchor" />
                    ))}
                    <h3 className="catalog-title">
                      <span className={`catalog-num mono ${r.assigned ? "" : "catalog-num--open"}`} title={r.assigned ? undefined : t.unassignedHelp}>
                        {r.number}
                      </span>
                      <Link href={`/developers/wisps/${r.slug}`}>{r.name}</Link>
                    </h3>
                    <div className="reader-chips">
                      <span className="chip">{r.status}</span>
                      <span className="chip">{t.kinds[r.kind] ?? r.kind}</span>
                      {r.parent && <span className="chip">{t.implements.replace("{n}", r.parent)}</span>}
                      {!r.assigned && <span className="chip chip--warn">{t.unassigned}</span>}
                      {r.level ? <LevelBadge level={r.level} /> : <span className="dim catalog-na">{r.kind === "Process" ? t.process : t.notClassified}</span>}
                    </div>
                    <p className="catalog-benefit">{r.benefit ?? r.implementation}</p>
                    {r.note && <p className="reader-note catalog-note">{r.note}</p>}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

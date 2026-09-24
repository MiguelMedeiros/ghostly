"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/site/icons";
import { LevelBadge } from "@/components/site/Level";
import { href, type Locale } from "@/lib/i18n";
import { LEVELS, type Level } from "@/lib/status";
import type { GroupId } from "@/lib/wisp-editorial";
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

export function Catalog({ rows, groups, t, locale }: { rows: CatalogRow[]; groups: CatalogGroup[]; t: CatalogCopy; locale: Locale }) {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<GroupId | "all">("all");
  const [kind, setKind] = useState<string>("all");
  const [level, setLevel] = useState<Level | "all">("all");

  // A link to #wisp-401 should land on that row even if filters were active.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (group !== "all" && r.group !== group) return false;
      if (kind !== "all" && r.kind !== kind) return false;
      if (level !== "all" && r.level !== level) return false;
      if (!needle) return true;
      return [r.number, r.id, r.name, r.benefit, r.note, r.implementation, r.slug].some((s) => s?.toLowerCase().includes(needle));
    });
  }, [rows, q, group, kind, level]);

  const filtered = q || group !== "all" || kind !== "all" || level !== "all";

  return (
    <div className="catalog">
      <div className="catalog-controls">
        <label className="catalog-search">
          <Icon name="search" />
          <span className="sr-only">{t.searchLabel}</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.search} />
        </label>
        <div className="catalog-filters">
          <label>
            <span>{t.family}</span>
            <select value={group} onChange={(e) => setGroup(e.target.value as GroupId | "all")}>
              <option value="all">{t.all}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </label>
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
                  {shell[locale].levels[l]}
                </option>
              ))}
            </select>
          </label>
          {filtered && (
            <button
              type="button"
              className="catalog-clear"
              onClick={() => {
                setQ("");
                setGroup("all");
                setKind("all");
                setLevel("all");
              }}
            >
              {t.clear}
            </button>
          )}
        </div>
        <p className="catalog-count mono" aria-live="polite">
          {t.results.replace("{n}", String(shown.length)).replace("{t}", String(rows.length))}
        </p>
      </div>

      {shown.length === 0 && <p className="catalog-none">{t.none}</p>}

      {groups.map((g) => {
        const items = shown.filter((r) => r.group === g.id);
        if (!items.length) return null;
        return (
          <section key={g.id} className="catalog-group" id={`family-${g.id}`} aria-labelledby={`family-${g.id}-title`}>
            <header className="catalog-group-head">
              <span className="catalog-group-icon" aria-hidden="true">
                <Icon name={g.icon} />
              </span>
              <div>
                <h2 id={`family-${g.id}-title`}>{g.title}</h2>
                <p className="muted">{g.blurb}</p>
              </div>
            </header>
            <ul className="catalog-list">
              {items.map((r) => (
                <li key={r.id} id={`wisp-${r.id}`} className="catalog-row" data-child={Boolean(r.parent)}>
                  {r.legacyIds.map((old) => (
                    <span key={old} id={`wisp-${old}`} className="anchor" />
                  ))}
                  <span className={`catalog-num mono ${r.assigned ? "" : "catalog-num--open"}`} title={r.assigned ? undefined : t.unassignedHelp}>
                    {r.number}
                  </span>
                  <div className="catalog-main">
                    <h3>
                      <Link href={href(locale, `/developers/wisps/${r.slug}`)}>{r.name}</Link>
                    </h3>
                    <p className="catalog-benefit">{r.benefit ?? r.implementation}</p>
                    {r.note && <p className="catalog-note">{r.note}</p>}
                    <div className="catalog-meta">
                      <span className="chip">{r.status}</span>
                      <span className="chip">{t.kinds[r.kind] ?? r.kind}</span>
                      {r.parent && <span className="chip">{t.implements.replace("{n}", r.parent)}</span>}
                      {!r.assigned && <span className="chip chip--warn">{t.unassigned}</span>}
                    </div>
                  </div>
                  <div className="catalog-level">
                    {r.level ? <LevelBadge level={r.level} locale={locale} small /> : <span className="dim catalog-na">{r.kind === "Process" ? t.process : t.notClassified}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

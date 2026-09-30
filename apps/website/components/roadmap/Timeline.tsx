import { Ghost } from "@/components/ghost/Ghost";
import { LevelBadge } from "@/components/site/Level";
import { PHASE_LEVEL, PHASES, timeline, type Phase } from "@/content/roadmap-timeline";
import { phaseItems, roadmapTracks } from "@/lib/roadmap";
import type { Level } from "@/lib/status";

type Item = { text: string; level: Level };
const text = (i: Item) => i.text;
const levelOf = (i: Item) => i.level;

/** One row per track of the roadmap document, its lines placed by stage. */
const LANES = roadmapTracks.map((track) => ({ id: track.id, color: track.color, title: track.lane, items: phaseItems(track) }));

function Chip({ item, phase, color, lane }: { item: Item; phase: Phase; color: string; lane?: string }) {
  const own = levelOf(item);
  return (
    <li className="tl-chip" style={{ "--lane": color } as React.CSSProperties}>
      {lane && <span className="tl-chip-lane">{lane}</span>}
      <span>{text(item)}</span>
      {own !== PHASE_LEVEL[phase] && <LevelBadge level={own} small />}
    </li>
  );
}

/**
 * Stages from left to right, areas from top to bottom. On a phone the same
 * data becomes a vertical timeline, one stage after another.
 */
export function Timeline() {
  const t = timeline;
  // A stage nobody has anything in (today: "being built", with everything merged) is left out.
  const phases = PHASES.filter((p) => LANES.some((lane) => lane.items[p]?.length));
  return (
    <div className="tl">
      <div className="tl-wide" role="region" aria-label={t.phases.now.title} tabIndex={0}>
        <div className="tl-grid" style={{ "--tl-cols": phases.length } as React.CSSProperties}>
          <div className="tl-corner" />
          {phases.map((p, i) => (
            <div key={p} className="tl-phase" data-phase={p} data-level={PHASE_LEVEL[p]}>
              <div className="tl-node-row">
                <span className="tl-node" />
                {i < phases.length - 1 && <span className="tl-line" data-future={i > 0} />}
              </div>
              {p === "now" && (
                <div className="tl-here" aria-hidden="true">
                  <Ghost who="boo" size={34} mood="happy" float={false} />
                  <span>{t.here}</span>
                </div>
              )}
              <h3>{t.phases[p].title}</h3>
              <p>{t.phases[p].sub}</p>
            </div>
          ))}
          {LANES.map((lane) => (
            <div key={lane.id} className="tl-row" style={{ "--lane": lane.color } as React.CSSProperties}>
              <div className="tl-lane">
                <span className="tl-lane-dot" />
                {lane.title}
              </div>
              {phases.map((p) => (
                <div key={p} className="tl-cell" data-phase={p}>
                  {lane.items[p]?.length ? (
                    <ul>
                      {lane.items[p]!.map((item) => (
                        <Chip key={text(item)} item={item} phase={p} color={lane.color} />
                      ))}
                    </ul>
                  ) : (
                    <span className="tl-empty" aria-hidden="true" />
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <ol className="tl-narrow">
        {phases.map((p) => {
          const items = LANES.flatMap((lane) => (lane.items[p] ?? []).map((item) => ({ item, lane })));
          return (
            <li key={p} className="tl-stage" data-phase={p} data-level={PHASE_LEVEL[p]}>
              <span className="tl-node" />
              {p === "now" && (
                <span className="tl-here" aria-hidden="true">
                  <Ghost who="boo" size={28} mood="happy" float={false} /> {t.here}
                </span>
              )}
              <h3>{t.phases[p].title}</h3>
              <p>{t.phases[p].sub}</p>
              <ul>
                {items.map(({ item, lane }) => (
                  <Chip key={lane.id + text(item)} item={item} phase={p} color={lane.color} lane={lane.title} />
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

import { Ghost, type GhostMood } from "@/components/ghost/Ghost";
import { Icon, type IconName } from "@/components/site/icons";
import { brandPage, SECTIONS } from "@/content/brand";
import brand from "@/lib/brand/brand.json";
import { shotSrcSet } from "@/lib/shots";
import { Section, Sub } from "./parts";

const head = (id: string) => SECTIONS.find((s) => s.id === id)!;
const ICONS: IconName[] = ["chat", "group", "file", "video", "bolt", "key", "lock", "globe", "phone", "desktop", "terminal", "download"];
const MOODS: { who: "boo" | "casper"; mood: GhostMood }[] = [
  { who: "boo", mood: "happy" },
  { who: "casper", mood: "talk" },
  { who: "boo", mood: "surprised" },
  { who: "casper", mood: "wink" },
  { who: "boo", mood: "curious" },
  { who: "casper", mood: "excited" },
  { who: "boo", mood: "sleep" },
];

export function IconsSection() {
  const t = brandPage.icons;
  const s = head("icons");
  return (
    <Section id={s.id} n={s.n} title={s.title} lead={t.lead}>
      <Sub title={t.style}>
        <div className="br-grid br-grid--2">
          <ul className="br-icons" aria-label="Line icons on their 24 pixel grid">
            {ICONS.map((name) => (
              <li key={name}>
                <Icon name={name} className="br-icon" />
                <span className="caption">{name}</span>
              </li>
            ))}
          </ul>
          <div className="br-panel">
            <div className="br-icon-sizes" aria-hidden="true">
              {[16, 20, 24].map((px) => (
                <span key={px}>
                  <span className="br-icon-box" style={{ width: px, height: px }}>
                    <Icon name="chat" className="br-icon-size" />
                  </span>
                  <span className="caption">{px} px</span>
                </span>
              ))}
            </div>
            <ul className="br-rules">
              {t.styleList.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        </div>
      </Sub>
      <Sub title={t.ghosts} note={t.ghostsText}>
        <ul className="br-moods" aria-label={t.moods}>
          {MOODS.map((m) => (
            <li key={`${m.who}-${m.mood}`}>
              <Ghost who={m.who} mood={m.mood} size={72} float={false} still title={`${m.who === "boo" ? "Boo" : "Casper"}, ${m.mood}`} />
              <span className="caption">{m.mood}</span>
            </li>
          ))}
        </ul>
        <ul className="br-rules br-after">
          {t.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Sub>
    </Section>
  );
}

/** A curve drawn from its cubic-bezier points, in a 100 x 100 box (y up). */
function Curve({ curve }: { curve: number[] }) {
  const [x1, y1, x2, y2] = curve;
  const p = (x: number, y: number) => `${(x * 100).toFixed(1)} ${(100 - y * 100).toFixed(1)}`;
  return (
    <svg viewBox="-10 -40 120 180" className="br-curve" aria-hidden="true">
      <rect x="0" y="0" width="100" height="100" fill="none" stroke="#1e293b" />
      <path d={`M${p(0, 0)} C${p(x1, y1)} ${p(x2, y2)} ${p(1, 1)}`} fill="none" stroke="#22d3ee" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function ImagerySection() {
  const t = brandPage.imagery;
  const s = head("imagery");
  const { durations, easings } = brand.motion;
  return (
    <Section id={s.id} n={s.n} title={s.title} lead={t.lead}>
      <Sub title={t.screenshots}>
        <div className="br-frames">
          <figure className="br-frame-desk">
            <div className="br-win">
              <div className="br-win-bar" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/screenshots/current/chat.webp"
                srcSet={shotSrcSet("/screenshots/current/chat.webp", "desktop")}
                sizes="(min-width: 1280px) 640px, 90vw"
                alt="Ghostly on a desktop: the chat list on the left, a conversation with messages, a file and a payment on the right"
                width={1280}
                height={820}
                loading="lazy"
                decoding="async"
              />
            </div>
            <figcaption className="caption">{t.frames.desktop}</figcaption>
          </figure>
          <figure className="br-frame-phone">
            <div className="br-phone">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/screenshots/current/chat-mobile.webp"
                srcSet={shotSrcSet("/screenshots/current/chat-mobile.webp", "phone")}
                sizes="220px"
                alt="Ghostly on a phone: a conversation"
                width={300}
                height={649}
                loading="lazy"
                decoding="async"
              />
            </div>
            <figcaption className="caption">{t.frames.phone}</figcaption>
          </figure>
        </div>
        <ul className="br-rules br-after">
          {t.screenshotList.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Sub>
      <Sub title={t.motion}>
        <ul className="br-rules">
          {t.principles.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Sub>
      <Sub title={t.durations} note={t.play}>
        <ul className="br-durs">
          {durations.map((d) => (
            <li key={d.token} tabIndex={0} style={{ "--d": `${d.ms}ms` } as React.CSSProperties}>
              <span className="br-dur-name">
                <strong>{d.name}</strong> <span className="mono dim">{d.ms} ms</span>
              </span>
              <span className="br-dur-track" aria-hidden="true">
                <span className="br-dur-dot" />
              </span>
              <span className="note">{d.use}</span>
            </li>
          ))}
        </ul>
      </Sub>
      <Sub title={t.easings}>
        <ul className="br-grid br-grid--5 br-easings">
          {easings.map((e) => (
            <li key={e.token} className="br-panel">
              <Curve curve={e.curve} />
              <strong>{e.name}</strong>
              <p className="mono br-curve-code">cubic-bezier({e.curve.join(", ")})</p>
              <p className="note">{e.use}</p>
            </li>
          ))}
        </ul>
      </Sub>
    </Section>
  );
}

export function VoiceSection() {
  const t = brandPage.voice;
  const s = head("voice");
  return (
    <Section id={s.id} n={s.n} title={s.title} lead={t.lead}>
      <Sub title={t.principles}>
        <ul className="br-grid br-grid--4">
          {t.principleList.map((p) => (
            <li key={p.name} className="br-panel">
              <strong>{p.name}</strong>
              <p className="muted">{p.text}</p>
            </li>
          ))}
        </ul>
      </Sub>
      <Sub title={t.pairs}>
        <ul className="br-pairs">
          {t.pairsList.map((p) => (
            <li key={p.yes}>
              <p className="br-pair br-pair--yes">
                <span className="br-pair-tag">{t.pairYes}</span>
                {p.yes}
              </p>
              <p className="br-pair br-pair--no">
                <span className="br-pair-tag">{t.pairNo}</span>
                {p.no}
              </p>
            </li>
          ))}
        </ul>
      </Sub>
      <Sub title={t.rules}>
        <ul className="br-rules">
          {t.ruleList.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Sub>
      <Sub title={t.naming}>
        <dl className="br-naming">
          {t.namingList.map((n) => (
            <div key={n.term}>
              <dt>{n.term}</dt>
              <dd>{n.text}</dd>
            </div>
          ))}
        </dl>
      </Sub>
      <Sub title={t.languages} note={t.languagesText}>
        <ul className="br-langs">
          {brand.voice.languages.map((l) => (
            <li key={l.code}>
              <span lang={l.code} dir={"dir" in l ? (l.dir as "rtl") : undefined}>
                {l.native}
              </span>
              <span className="caption">{l.name}</span>
            </li>
          ))}
        </ul>
      </Sub>
    </Section>
  );
}

import { THEME_COLOR, themeOf, type ProfileEntry } from "../lib/profiles";

/** A local profile's picture, or its initial in its own color: which profile this is, at a glance (WISP 04). */
export function ProfileBadge({ entry, size = 44, avatar }: { entry: ProfileEntry; size?: number; avatar?: string }) {
  if (avatar) return <img src={avatar} alt="" draggable={false} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  return (
    <span aria-hidden="true" className="shrink-0 grid place-items-center rounded-full font-semibold text-[#111b21]" style={{ width: size, height: size, background: THEME_COLOR[themeOf(entry.id)], fontSize: size * 0.42 }}>
      {entry.name.charAt(0).toUpperCase()}
    </span>
  );
}

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { memberText, rosterColors } from "../lib/memberColors";

/** The group's hues by member key (lib/memberColors.ts `rosterColors`), for whatever inside it names a member. */
const MemberColors = createContext<ReadonlyMap<string, number> | undefined>(undefined);

/** A group's page: everything in it colours its members by the group's roster. */
export function MemberColorsProvider({ keys, children }: { keys: readonly string[]; children: ReactNode }) {
  const roster = [...keys].sort().join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `roster` is `keys`, as a value
  const colors = useMemo(() => rosterColors(keys), [roster]);
  return <MemberColors.Provider value={colors}>{children}</MemberColors.Provider>;
}

/** A member's text class: by the group's roster inside a group's page, by their key alone anywhere else. */
export function useMemberText(): (key: string) => string {
  const colors = useContext(MemberColors);
  return useCallback((key: string) => memberText(key, colors), [colors]);
}

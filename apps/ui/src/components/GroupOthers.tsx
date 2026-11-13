import { engine } from "@ghostly/browser/platform/engine";
import type { GroupView } from "@ghostly/browser/shared/types";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useI18n } from "../contexts/I18nContext";
import { focusLost } from "../lib/focus";
import { DeleteChatDialog } from "./DeleteChatDialog";

type Other = NonNullable<GroupView["others"]>[number];

/**
 * Another group came under this one's id (a contact's invitation, or a link opened): a private group's id names no
 * genesis, so anyone who knows it can make a group of their own under it. Only one of them is kept on this device:
 * the band says so and lets the person pick. Keep this one turns the others down (their inviters are told); Switch
 * takes the other in its place, as Delete takes this one, and so is asked first as Delete is: the dialog names the other
 * picked, Cancel has the focus, and closed it gives the focus back to that Switch. `act`: the page's runner, which says
 * why one did not go. Answered, the band goes with the button pressed and the focus would fall to the page: it goes to
 * `focusAfter` (the group's name) instead, unless it went elsewhere meanwhile.
 */
export function GroupOthers({ group, act, focusAfter }: { group: GroupView; act: (action: () => Promise<unknown>) => Promise<void>; focusAfter: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const [asking, setAsking] = useState<Other | null>(null);
  const answered = useRef(false);
  const others = group.others;
  const shown = !!others?.length;
  useLayoutEffect(() => {
    if (shown || !answered.current) return;
    answered.current = false;
    if (focusLost()) focusAfter.current?.focus();
  }, [shown, focusAfter]);
  if (!others?.length) return null;
  const line = (other: Other) => {
    if ("link" in other) return t("group.others.link");
    const members = other.members === 1 ? t("group.chat.memberOne") : t("group.chat.memberCount", { count: other.members });
    const name = other.name || t("group.chat.unnamed");
    return other.contact ? t("group.others.invitedBy", { contact: other.contact, name, members }) : t("group.others.invitedByUnknown", { name, members });
  };
  const button = "min-h-11 shrink-0 rounded-lg px-3 text-xs focus-visible:ring-2 focus-visible:ring-accent";
  return <div role="status" data-testid="group-others" className="border-b border-border bg-surface-alt px-4 py-2 text-xs text-text-secondary">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="min-w-0"><span className="block font-medium text-text-primary">{t("group.others.title")}</span>{t("group.others.body")}</p>
      <button data-testid="group-others-keep" onClick={() => { answered.current = true; void act(() => engine.call("keepGroup", { groupId: group.id })); }}
        className={`${button} bg-accent font-semibold text-panel-header hover:bg-accent-hover forced-colors:border forced-colors:border-[color:ButtonText]`}>{t("group.others.keep")}</button>
    </div>
    <ul className="mt-2 space-y-1">
      {others.map(other => {
        const to = "link" in other ? other.link : other.linkId;
        return <li key={to} data-testid="group-other" className="flex items-center justify-between gap-2">
          <span className="min-w-0 break-words">{line(other)}</span>
          {/* Focused before it asks: a browser that leaves a clicked button unfocused (Safari) still gets it back. */}
          <button data-testid="group-other-switch" onClick={e => { e.currentTarget.focus(); setAsking(other); }}
            className={`${button} text-text-secondary hover:bg-surface-hover`}>{t("group.others.switch")}</button>
        </li>;
      })}
    </ul>
    {asking && <DeleteChatDialog name={line(asking)} title={t("group.others.switchTitle")} body={t("group.others.switchBody", { other: line(asking) })}
      confirm={t("group.others.switchConfirm")} onClose={() => setAsking(null)} onConfirm={() => {
        const to = "link" in asking ? asking.link : asking.linkId;
        setAsking(null);
        answered.current = true;
        void act(() => engine.call("switchGroup", { groupId: group.id, to }));
      }} />}
  </div>;
}

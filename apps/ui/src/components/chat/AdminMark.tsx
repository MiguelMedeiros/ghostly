import { useI18n } from "../../contexts/I18nContext";

/**
 * The group admin's mark beside their name in the chat (over their messages, in the lines that name them), as the
 * members list has it. Names are what each member says it is called, and anyone can take the admin's: never this.
 */
export function AdminMark({ testId }: { testId: string }) {
  const { t } = useI18n();
  return <span data-testid={testId} className="shrink-0 rounded-full bg-accent/15 px-1.5 py-px align-middle text-[10px] font-bold uppercase tracking-wider text-accent">{t("group.members.admin")}</span>;
}

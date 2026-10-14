import { useState, type RefObject } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { createFolder, setChatFolder, useChatFolders } from "../../lib/chatFolders";
import { Menu, MenuItem, MenuSeparator } from "../Menu";
import { FolderNameDialog } from "./ChatFolderDialogs";

export function FolderIcon() {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
}

/** Where the chat is now: a tick before its folder (or before "No folder"), and the same room left empty before the others. */
function Tick({ on }: { on: boolean }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">{on && <path d="M5 12.5l4.5 4.5L19 7.5" />}</svg>;
}

/** The ⋮ menu row of a chat or a group: "Move to folder…" opens the folders (`onChoose`), with the chat's folder under it. */
export function FolderMenuItem({ chat, onChoose }: { chat: string; onChoose(): void }) {
  const { t } = useI18n();
  const { folders, folderOf } = useChatFolders();
  const current = folders.find(f => f.id === folderOf(chat));
  return <MenuItem testId="chat-folder-open" icon={<FolderIcon />} hint={current?.name} onClick={onChoose}>{t("sidebar.folder.move")}</MenuItem>;
}

/**
 * Where a chat goes: one of the folders (its own is ticked), no folder, or a new folder made for it on the spot.
 * `chat`: a session id, or `groupChat(id)`. Kept mounted by its opener: the dialog that names a new folder outlives the menu.
 */
export function ChatFolderMenu({ chat, open, onClose, anchorRef, returnFocus }: {
  chat: string; open: boolean; onClose(): void; anchorRef: RefObject<HTMLElement | null>; returnFocus?: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const { folders, folderOf } = useChatFolders();
  const [naming, setNaming] = useState(false);
  const current = folderOf(chat);
  const put = (folder: string | undefined) => { setChatFolder(chat, folder); onClose(); };
  return <>
    <Menu testId="chat-folder-menu" open={open} onClose={onClose} anchorRef={anchorRef} focusFirst label={t("sidebar.folder.move")}>
      {folders.map(folder => (
        <MenuItem key={folder.id} testId="chat-folder-choice" data={{ "data-folder": folder.id }} checked={current === folder.id} icon={<Tick on={current === folder.id} />} onClick={() => put(folder.id)}>
          <span dir="auto">{folder.name}</span>
        </MenuItem>
      ))}
      {folders.length > 0 && <>
        <MenuItem testId="chat-folder-none" checked={current === undefined} icon={<Tick on={current === undefined} />} onClick={() => put(undefined)}>{t("sidebar.folder.none")}</MenuItem>
        <MenuSeparator />
      </>}
      <MenuItem testId="chat-folder-new" icon={<FolderIcon />} onClick={() => { onClose(); setNaming(true); }}>{t("sidebar.folder.new")}</MenuItem>
    </Menu>
    {naming && <FolderNameDialog returnFocus={returnFocus} onClose={() => setNaming(false)}
      onSave={name => { const folder = createFolder(name); if (folder) setChatFolder(chat, folder.id); setNaming(false); }} />}
  </>;
}

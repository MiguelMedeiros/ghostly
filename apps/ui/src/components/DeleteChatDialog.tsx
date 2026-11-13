import {useEffect, useId, useRef} from "react";
import {createPortal} from "react-dom";
import {useI18n} from "../contexts/I18nContext";
import {useBackdropDismiss, useBackCloses} from "../hooks/useDismiss";
import {useEngineValue} from "../lib/engineState";

/**
 * "Delete chat?" for a contact chat. `title`, `body` and `confirm`: a group's own words (a group I am no longer in, or
 * an invitation), which name no contact's copy; the title names the group, so the name is not said again under it.
 * `callOn`: a call is on or rings in the chat (lib/chatsOnCall.ts): it says to end the call first, and Delete is off.
 * `peerKey`: the contact's, whose chat's removals still on their way (`LinkView.removalsPending`) go with the chat: it
 * says the contact keeps that message, and Delete stays on.
 */
export function DeleteChatDialog({name, onClose, onConfirm, title, body, confirm: confirmLabel, callOn=false, peerKey}: {name:string; onClose():void; onConfirm():void; title?:string; body?:string; confirm?:string; callOn?:boolean; peerKey?:string}) {
  const {t}=useI18n(); const id=useId();
  const removalsPending=useEngineValue(state=>!!peerKey && !!state?.links.find(l=>l.peerPubKeyZ32===peerKey)?.removalsPending?.length);
  const dialog=useRef<HTMLDialogElement>(null), cancel=useRef<HTMLButtonElement>(null), confirm=useRef<HTMLButtonElement>(null);
  const backdrop=useBackdropDismiss(onClose);
  useBackCloses(onClose);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement | null;
    const element=dialog.current!; element.showModal(); cancel.current?.focus();
    return ()=>{element.close(); if(previous?.isConnected) previous.focus(); else document.querySelector<HTMLButtonElement>('[data-testid="sidebar-new-chat"]')?.focus();};
  },[]);
  // A call that starts while Delete has the focus turns it off under the focus, which a browser drops to the page
  // (where Tab goes nowhere): Cancel takes it, as when the dialog opens.
  useEffect(()=>{
    if(callOn && (document.activeElement===confirm.current || document.activeElement===document.body)) cancel.current?.focus();
  },[callOn]);
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e=>{e.preventDefault();onClose();}}
    onKeyDown={e=>{if(e.key==="Tab") {e.preventDefault();(document.activeElement===cancel.current ? confirm.current : cancel.current)?.focus();}}}
    aria-labelledby={`${id}-title`} aria-describedby={removalsPending ? `${id}-body ${id}-pending` : `${id}-body`}
    className="m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <h2 id={`${id}-title`} className="break-words text-base font-semibold">{title ?? t("common.deleteChatTitle")}</h2>
    {!title && <p className="mt-2 break-words text-sm font-medium">{name}</p>}
    <p id={`${id}-body`} className="mt-2 text-sm text-text-muted">{callOn ? t("common.deleteChatCallOn") : body ?? t("common.deleteChatLocal")}</p>
    {removalsPending && <p id={`${id}-pending`} className="mt-2 text-sm text-text-muted">{t("common.deleteChatRemovalPending")}</p>}
    <div className="mt-5 flex justify-end gap-2">
      <button ref={cancel} onClick={onClose} className="min-h-11 rounded-lg px-4 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">{t("common.cancel")}</button>
      <button ref={confirm} onClick={onConfirm} disabled={callOn} className="min-h-11 rounded-lg bg-danger/15 px-4 text-sm text-danger-ink hover:bg-danger/25 focus-visible:ring-2 focus-visible:ring-danger disabled:opacity-50 disabled:hover:bg-danger/15">{confirmLabel ?? t("sidebar.deleteChat")}</button>
    </div>
  </dialog>,document.body);
}

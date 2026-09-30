import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { InputGroup, LinkRow, Page } from "../components/layout";
import { useSettings } from "../contexts/SettingsContext";
import { useI18n } from "../contexts/I18nContext";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { listSessions } from "../lib/storage";
import { type ColorScheme } from "../lib/settings";
import { ColorSwatches } from "../components/ColorSwatches";
import { createProfile, currentProfile, listProfiles, renameProfile, switchProfile, type ProfileEntry } from "../lib/profiles";
import { Block, Button, Notice, Row, Section, Segmented, Switch, input } from "../components/wallet/ui";
import { ProfileBackups } from "../components/ProfileBackups";
import { useEngineState, useIdentityAttention } from "../lib/identities";
import { DeleteProfileDialog } from "../components/DeleteProfileDialog";
import { ProfileBadge } from "../components/ProfileBadge";
import { setMyAvatar, setShareProfile, useMyAvatar, useShareProfile } from "../hooks/useAvatars";
import { avatarFromFile } from "../lib/avatarImage";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { formatAmount } from "../lib/amount";
import { useComposition } from "../hooks/useComposition";
import { errorText } from "../lib/errorText";

/** Profiles change outside React (another component, another tab); re-read them when they do. */
function useProfiles() {
  const [, bump] = useState(0);
  useEffect(() => {
    const changed = () => bump((n) => n + 1);
    for (const name of ["profiles-updated", "settings-updated", "storage"]) window.addEventListener(name, changed);
    return () => { for (const name of ["profiles-updated", "settings-updated", "storage"]) window.removeEventListener(name, changed); };
  }, []);
  return { current: currentProfile(), all: listProfiles() };
}

/**
 * The active local profile (WISP 04), as a page beside the chat list: its name and look, what belongs to
 * it, its backups, and the other profiles on this device.
 */
export function Profile() {
  const nav = useAppNavigation();
  const { t, language } = useI18n();
  const { settings, updateColorScheme, updateDefaultNickname, randomizeNickname } = useSettings();
  const platform = useServicesPlatform();
  const { current, all } = useProfiles();
  const myAvatar = useMyAvatar();
  const shareProfile = useShareProfile();
  const identities = useEngineState()?.identityProofs.length ?? 0;
  const identityAttention = useIdentityAttention();
  const [name, setName] = useState(current.name);
  const nameComposition = useComposition();
  // "Add a profile" in the account switcher lands here with the form open.
  const asked = useLocation().state as { newProfile?: boolean; backupProfile?: boolean } | null;
  const wantsNew = !!asked?.newProfile;
  // The wallet's backup reminder (Cashu has no phrase) lands here with the profile's Back up open.
  const wantsBackup = !!asked?.backupProfile;
  const [creating, setCreating] = useState(wantsNew), [newName, setNewName] = useState("");
  useEffect(() => { if (wantsNew) { setCreating(true); document.querySelector("[data-testid='profile-list']")?.scrollIntoView({ block: "nearest" }); } }, [wantsNew]);
  const [deleting, setDeleting] = useState<ProfileEntry | null>(null);
  const [error, setError] = useState("");
  useEffect(() => setName(current.name), [current.name]);

  const canSwitch = !!platform?.features.profiles;
  const wallet = platform?.wallet?.getState();
  const services = platform?.features.shareLocalServices ? platform.getSharedServices() : [];
  const chats = listSessions().length;
  const attempt = (work: () => void) => { try { work(); setError(""); } catch (e) { setError(errorText(e, t)); } };
  const saveName = () => { if (name.trim() && name.trim() !== current.name) attempt(() => renameProfile(current.id, name)); };
  const schemes: { value: ColorScheme; label: string }[] = [{ value: "light", label: t("settings.colorSchemes.light") }, { value: "dark", label: t("settings.colorSchemes.dark") }, { value: "system", label: t("settings.colorSchemes.system") }];

  return (
    <Page title={t("settings.profile")} width="md" testId="profile-page">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* The picture goes to paired contacts with the name: a fresh 128×128 JPEG, nothing of the file. */}
        <label className="relative shrink-0 cursor-pointer group rounded-full focus-within:ring-2 focus-within:ring-accent" title={myAvatar ? t("profile.changePictureHint") : t("profile.addPictureHint")}>
          <ProfileBadge entry={{ ...current, name: name || current.name }} size={52} avatar={myAvatar} />
          <span aria-hidden="true" className="absolute inset-0 rounded-full bg-black/45 grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
          </span>
          <input data-testid="profile-avatar-input" type="file" accept="image/*" aria-label={myAvatar ? t("profile.changePicture") : t("profile.addPicture")} className="sr-only"
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void avatarFromFile(file).then(setMyAvatar).then(() => setError(""), (err: unknown) => setError(errorText(err, t))); }} />
        </label>
        <input data-testid="profile-name" aria-label={t("profile.nameLabel")} value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onBlur={saveName} {...nameComposition.inputProps} onKeyDown={(e) => !nameComposition.composing(e) && e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          className="min-w-0 flex-[1_1_8rem] bg-transparent text-xl font-semibold text-text-primary rounded-lg px-2 -mx-2 py-1 border border-transparent hover:border-border focus:border-accent focus:outline-none" />
        {myAvatar && <button type="button" data-testid="profile-avatar-remove" onClick={() => void setMyAvatar(null)} className="min-h-10 text-xs text-text-muted hover:text-danger cursor-pointer shrink-0 whitespace-nowrap">{t("profile.removePicture")}</button>}
      </div>
      {error && <Notice tone="error">{error}</Notice>}

      <Section title={t("profile.look")}>
        <Row label={t("profile.color")}><ColorSwatches label={t("profile.colorLabel")} testIdPrefix="profile-theme" /></Row>
        <Row label={t("profile.mode")}><Segmented label={t("profile.mode")} value={settings.colorScheme} options={schemes} onChange={updateColorScheme} /></Row>
        <Row label={t("profile.nameInChats")}>
          <input data-testid="account-nickname" aria-label={t("settings.nicknamePlaceholder")} className={`${input} w-44 flex-1`} value={settings.defaultNickname} maxLength={20} placeholder={t("common.anonymous")} onChange={(e) => updateDefaultNickname(e.target.value)} />
          <button type="button" onClick={randomizeNickname} title={t("settings.randomizeName")} aria-label={t("settings.randomizeName")} className="grid place-items-center w-10 h-10 shrink-0 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-alt cursor-pointer">↻</button>
        </Row>
        {/* Per profile: contacts are told at once, or told there is nothing to show (WISP 401 § name and picture). */}
        <Row label={t("settings.shareProfile")} hint={t("settings.shareProfileHint")}>
          <Switch testId="profile-share" label={t("settings.shareProfile")} checked={shareProfile}
            onChange={(share) => void setShareProfile(share).then(() => setError(""), (err: unknown) => setError(errorText(err, t)))} />
        </Row>
      </Section>

      <Section title={t("profile.inThisProfile")} testId="profile-links">
        {/* Identities have a page of their own; this row is the way there from what used to hold them. */}
        <LinkRow testId="profile-identities-link" label={<span className="inline-flex items-center gap-2">{t("tabs.identities")}{identityAttention && <><span className="nav-dot-inline" aria-hidden="true" /><span className="sr-only">, {t("identities.attention")}</span></>}</span>}
          value={identities ? identities : undefined} onClick={() => nav.open("/identities")} />
        <LinkRow label={t("tabs.chats")} value={chats === 1 ? t("profile.chatOne") : t("profile.chatCount", { count: chats })} onClick={nav.home} />
        <LinkRow label={t("tabs.wallets")} value={wallet ? t("profile.sats", { amount: formatAmount(wallet.balance, language) }) : undefined} onClick={() => nav.open("/wallet")} />
        <LinkRow label={t("tabs.services")} value={services.length ? services.length : undefined} onClick={() => nav.open("/services")} />
        <LinkRow label={t("settings.title")} onClick={() => nav.open("/settings")} />
      </Section>

      <ProfileBackups canSwitch={canSwitch} openBackup={wantsBackup} />

      <Section title={t("profile.profiles")} testId="profile-list">
        {all.map((entry) => (
          <div key={entry.id || "default"} className="flex items-center gap-3 px-4 py-2.5 min-h-14" data-testid="profile-row">
            <ProfileBadge entry={entry} size={30} avatar={entry.id === current.id ? myAvatar : undefined} />
            <p className="flex-1 min-w-0 text-sm text-text-primary truncate">{entry.name}</p>
            {entry.id === current.id ? <span className="text-xs text-accent shrink-0">{t("profile.inUse")}</span> : <>
              <Button data-testid="profile-switch" disabled={!canSwitch} onClick={() => attempt(() => switchProfile(entry.id))}>{t("profile.switch")}</Button>
              {entry.id && (
                <button type="button" data-testid="profile-delete" aria-label={t("profile.deleteNamed", { name: entry.name })} title={t("common.delete")} onClick={() => setDeleting(entry)} className="grid place-items-center w-10 h-10 shrink-0 rounded-lg text-text-muted hover:text-danger hover:bg-surface-alt cursor-pointer">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>
                </button>
              )}
            </>}
          </div>
        ))}
        {!canSwitch ? <Block><Notice>{t("profile.oneOnly")}</Notice></Block> : creating ? (
          <Block>
            <InputGroup as="form" onSubmit={(e) => { e.preventDefault(); attempt(() => { const entry = createProfile(newName); switchProfile(entry.id, { route: "/profile" }); }); }}>
              <input data-testid="profile-new-name" autoFocus className={input} placeholder={t("profile.name")} maxLength={32} value={newName} onChange={(e) => setNewName(e.target.value)} />
              <Button type="submit" variant="primary" data-testid="profile-create" disabled={!newName.trim()}>{t("profile.create")}</Button>
              <Button onClick={() => { setCreating(false); setNewName(""); }}>{t("common.cancel")}</Button>
            </InputGroup>
          </Block>
        ) : (
          <button data-testid="profile-new" onClick={() => setCreating(true)} className="w-full px-4 py-3 min-h-12 text-left text-sm text-text-secondary hover:text-accent hover:bg-surface-alt transition-colors cursor-pointer rounded-b-xl">{t("profile.newProfile")}</button>
        )}
      </Section>
      {deleting && <DeleteProfileDialog entry={deleting} onClose={() => setDeleting(null)} />}
    </Page>
  );
}

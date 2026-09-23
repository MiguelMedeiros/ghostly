import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { InputGroup, Page } from "../components/layout";
import { useSettings } from "../contexts/SettingsContext";
import { useI18n } from "../contexts/I18nContext";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { listSessions } from "../lib/storage";
import { COLOR_THEME_OPTIONS, type ColorScheme } from "../lib/settings";
import { createProfile, currentProfile, listProfiles, renameProfile, switchProfile, THEME_COLOR, type ProfileEntry } from "../lib/profiles";
import { Block, Button, Notice, Row, Section, Segmented, input } from "../components/wallet/ui";
import { ProfileBackups } from "../components/ProfileBackups";
import { IdentityProofsSection } from "../components/identities/IdentityProofsSection";
import { DeleteProfileDialog } from "../components/DeleteProfileDialog";
import { ProfileBadge } from "../components/ProfileBadge";
import { setMyAvatar, useMyAvatar } from "../hooks/useAvatars";
import { avatarFromFile } from "../lib/avatarImage";

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

/** A row that is a link: label, value, chevron. */
function LinkRow({ label, value, onClick }: { label: string; value?: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="w-full flex items-center gap-3 px-4 py-3 min-h-12 text-left hover:bg-surface-alt transition-colors cursor-pointer first:rounded-t-xl last:rounded-b-xl">
      <span className="flex-1 min-w-0 truncate text-sm text-text-primary">{label}</span>
      {value !== undefined && <span className="shrink-0 whitespace-nowrap text-sm text-text-muted tabular-nums">{value}</span>}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="shrink-0 text-text-muted" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
    </button>
  );
}

/**
 * The active local profile (WISP 04), as a page beside the chat list: its name and look, what belongs to
 * it, its backups, and the other profiles on this device.
 */
export function Profile() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { settings, updateColorTheme, updateColorScheme, updateDefaultNickname, randomizeNickname } = useSettings();
  const platform = useServicesPlatform();
  const { current, all } = useProfiles();
  const myAvatar = useMyAvatar();
  const [name, setName] = useState(current.name);
  const [creating, setCreating] = useState(false), [newName, setNewName] = useState("");
  const [deleting, setDeleting] = useState<ProfileEntry | null>(null);
  const [error, setError] = useState("");
  useEffect(() => setName(current.name), [current.name]);

  const canSwitch = !!platform?.features.profiles;
  const wallet = platform?.wallet?.getState();
  const services = platform?.features.shareLocalServices ? platform.getSharedServices() : [];
  const chats = listSessions().length;
  const attempt = (work: () => void) => { try { work(); setError(""); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const saveName = () => { if (name.trim() && name.trim() !== current.name) attempt(() => renameProfile(current.id, name)); };
  const schemes: { value: ColorScheme; label: string }[] = [{ value: "light", label: t("settings.colorSchemes.light") }, { value: "dark", label: t("settings.colorSchemes.dark") }, { value: "system", label: t("settings.colorSchemes.system") }];

  return (
    <Page title={t("settings.profile")} width="md" testId="profile-page">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* The picture goes to paired contacts with the name: a fresh 128×128 JPEG, nothing of the file. */}
        <label className="relative shrink-0 cursor-pointer group rounded-full focus-within:ring-2 focus-within:ring-accent" title={myAvatar ? "Change picture · contacts see it" : "Add a picture · contacts see it"}>
          <ProfileBadge entry={{ ...current, name: name || current.name }} size={52} avatar={myAvatar} />
          <span aria-hidden="true" className="absolute inset-0 rounded-full bg-black/45 grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
          </span>
          <input data-testid="profile-avatar-input" type="file" accept="image/*" aria-label={myAvatar ? "Change picture" : "Add a picture"} className="sr-only"
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void avatarFromFile(file).then(setMyAvatar).then(() => setError(""), (err: unknown) => setError(err instanceof Error ? err.message : String(err))); }} />
        </label>
        <input data-testid="profile-name" aria-label="Profile name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          className="min-w-0 flex-[1_1_8rem] bg-transparent text-xl font-semibold text-text-primary rounded-lg px-2 -mx-2 py-1 border border-transparent hover:border-border focus:border-accent focus:outline-none" />
        {myAvatar && <button type="button" data-testid="profile-avatar-remove" onClick={() => void setMyAvatar(null)} className="min-h-10 text-xs text-text-muted hover:text-danger cursor-pointer shrink-0 whitespace-nowrap">Remove picture</button>}
      </div>
      {error && <Notice tone="error">{error}</Notice>}

      <Section title="Look">
        <Row label="Color">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Profile color">
            {COLOR_THEME_OPTIONS.map((option) => (
              <button key={option.value} type="button" role="radio" aria-checked={settings.colorTheme === option.value} aria-label={t(option.labelKey as Parameters<typeof t>[0])} title={option.description} data-testid={`profile-theme-${option.value}`}
                onClick={() => updateColorTheme(option.value)}
                className={`w-8 h-8 rounded-full border-2 transition-transform cursor-pointer ${settings.colorTheme === option.value ? "border-text-primary scale-110" : "border-transparent hover:scale-105"}`}
                style={{ background: THEME_COLOR[option.value] }} />
            ))}
          </div>
        </Row>
        <Row label="Mode"><Segmented label="Mode" value={settings.colorScheme} options={schemes} onChange={updateColorScheme} /></Row>
        <Row label="Name in chats">
          <input data-testid="account-nickname" aria-label={t("settings.nicknamePlaceholder")} className={`${input} w-44 flex-1`} value={settings.defaultNickname} maxLength={20} placeholder="Anonymous" onChange={(e) => updateDefaultNickname(e.target.value)} />
          <button type="button" onClick={randomizeNickname} title={t("settings.randomizeName")} aria-label={t("settings.randomizeName")} className="grid place-items-center w-10 h-10 shrink-0 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-alt cursor-pointer">↻</button>
        </Row>
      </Section>

      <IdentityProofsSection />

      <Section title="In this profile" testId="profile-links">
        <LinkRow label="Chats" value={`${chats} ${chats === 1 ? "chat" : "chats"}`} onClick={() => navigate("/")} />
        <LinkRow label="Wallets" value={wallet ? `${wallet.balance.toLocaleString()} sats` : undefined} onClick={() => navigate("/wallet")} />
        <LinkRow label="Services" value={services.length ? services.length : undefined} onClick={() => navigate("/services")} />
        <LinkRow label="Settings" onClick={() => navigate("/settings")} />
      </Section>

      <ProfileBackups canSwitch={canSwitch} />

      <Section title="Profiles" testId="profile-list">
        {all.map((entry) => (
          <div key={entry.id || "default"} className="flex items-center gap-3 px-4 py-2.5 min-h-14" data-testid="profile-row">
            <ProfileBadge entry={entry} size={30} avatar={entry.id === current.id ? myAvatar : undefined} />
            <p className="flex-1 min-w-0 text-sm text-text-primary truncate">{entry.name}</p>
            {entry.id === current.id ? <span className="text-xs text-accent shrink-0">In use</span> : <>
              <Button data-testid="profile-switch" disabled={!canSwitch} onClick={() => attempt(() => switchProfile(entry.id))}>Switch</Button>
              {entry.id && (
                <button type="button" data-testid="profile-delete" aria-label={`Delete ${entry.name}`} title="Delete" onClick={() => setDeleting(entry)} className="grid place-items-center w-10 h-10 shrink-0 rounded-lg text-text-muted hover:text-danger hover:bg-surface-alt cursor-pointer">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>
                </button>
              )}
            </>}
          </div>
        ))}
        {!canSwitch ? <Block><Notice>One profile only in this client, for now.</Notice></Block> : creating ? (
          <Block>
            <InputGroup as="form" onSubmit={(e) => { e.preventDefault(); attempt(() => { const entry = createProfile(newName); switchProfile(entry.id); }); }}>
              <input data-testid="profile-new-name" autoFocus className={input} placeholder="Name" maxLength={32} value={newName} onChange={(e) => setNewName(e.target.value)} />
              <Button type="submit" variant="primary" data-testid="profile-create" disabled={!newName.trim()}>Create</Button>
              <Button onClick={() => { setCreating(false); setNewName(""); }}>Cancel</Button>
            </InputGroup>
          </Block>
        ) : (
          <button data-testid="profile-new" onClick={() => setCreating(true)} className="w-full px-4 py-3 min-h-12 text-left text-sm text-text-secondary hover:text-accent hover:bg-surface-alt transition-colors cursor-pointer rounded-b-xl">+ New profile</button>
        )}
      </Section>
      {deleting && <DeleteProfileDialog entry={deleting} onClose={() => setDeleting(null)} />}
    </Page>
  );
}

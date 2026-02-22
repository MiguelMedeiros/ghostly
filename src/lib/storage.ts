import type { ChatMessage, ChatSession } from "./types";

let _profile = "";

export function setStorageProfile(profile: string): void {
  _profile = profile;
}

function getPrefix(): string {
  return _profile ? `deaddrop_${_profile}_` : "deaddrop_";
}

function getKey(sessionId: string): string {
  return `${getPrefix()}${sessionId}`;
}

export function saveSession(session: ChatSession): void {
  try {
    localStorage.setItem(getKey(session.id), JSON.stringify(session));
  } catch {
    // storage full or unavailable
  }
}

export function loadSession(sessionId: string): ChatSession | null {
  try {
    const raw = localStorage.getItem(getKey(sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as ChatSession;
  } catch {
    return null;
  }
}

export function addMessage(
  sessionId: string,
  message: ChatMessage,
): ChatSession | null {
  const session = loadSession(sessionId);
  if (!session) return null;

  const exists = session.messages.some((m) => m.id === message.id);
  if (exists) return session;

  session.messages.push(message);
  session.messages.sort((a, b) => a.timestamp - b.timestamp);
  session.lastSyncAt = Date.now();
  saveSession(session);
  return session;
}

export function deleteSession(sessionId: string): void {
  try {
    localStorage.removeItem(getKey(sessionId));
  } catch {
    // ignore
  }
}

export function deleteAllSessions(): void {
  const prefix = getPrefix();
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
}

export function listSessions(): ChatSession[] {
  const sessions: ChatSession[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    try {
      const key = localStorage.key(i);
      if (!key?.startsWith(getPrefix())) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const session = JSON.parse(raw) as ChatSession;
      if (session.id && session.mySeedB64 && session.peerPubKeyB64 && session.encKeyB64) {
        sessions.push(session);
      }
    } catch {
      continue;
    }
  }
  sessions.sort((a, b) => {
    const aTime = a.lastSyncAt ?? a.createdAt;
    const bTime = b.lastSyncAt ?? b.createdAt;
    return bTime - aTime;
  });
  return sessions;
}

export function getLastReadCount(sessionId: string): number {
  try {
    const val = localStorage.getItem(`${getPrefix()}read_${sessionId}`);
    return val ? parseInt(val, 10) : 0;
  } catch {
    return 0;
  }
}

export function markSessionAsRead(sessionId: string): void {
  const session = loadSession(sessionId);
  if (!session) return;
  try {
    localStorage.setItem(
      `${getPrefix()}read_${sessionId}`,
      String(session.messages.length),
    );
  } catch {
    // storage full or unavailable
  }
}

export function getUnreadCount(session: ChatSession): number {
  const lastRead = getLastReadCount(session.id);
  return Math.max(0, session.messages.length - lastRead);
}

export function updateSessionLabel(sessionId: string, label: string): void {
  const session = loadSession(sessionId);
  if (!session) return;
  session.label = label || undefined;
  saveSession(session);
}

export function saveInviteCode(sessionId: string, code: string): void {
  try {
    localStorage.setItem(`${getPrefix()}invite_${sessionId}`, code);
  } catch {
    // storage full or unavailable
  }
}

export function getInviteCode(sessionId: string): string | null {
  try {
    return localStorage.getItem(`${getPrefix()}invite_${sessionId}`);
  } catch {
    return null;
  }
}

export function generateSessionId(
  mySeedB64: string,
  peerPubKeyB64: string,
): string {
  const combined = mySeedB64.slice(0, 8) + peerPubKeyB64.slice(0, 8);
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

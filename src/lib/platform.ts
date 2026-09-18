import type { DataLinkState, ServiceAd } from "@ghostly/core";
import type { ChatFile } from "./types";

/**
 * What a platform has to provide for ephemeral services. Ghostly Browser
 * swaps this module for one backed by its peer; on Desktop it is not
 * implemented yet, and the UI that depends on it stays hidden.
 */
export interface SharedService {
  id: string;
  name: string;
  /** Loopback address, e.g. `http://localhost:3400` */
  target: string;
  enabled: boolean;
  requests: number;
}

export interface PeerLinkState {
  dataLink: DataLinkState;
  online: boolean;
  /** `null` while the peer advertises nothing (offline, or an older client). */
  services: ServiceAd[] | null;
}

export interface NetworkSettings {
  /** How this client reaches Pkarr, for display. */
  protocol: string;
  relays: string[];
  defaultRelays: string[];
  /** Optional TURN server, used only when no direct path exists. */
  turn: { urls: string; username?: string; credential?: string } | null;
}

export interface FileTransferState {
  state: "transferring" | "done" | "failed";
  transferred: number;
  size: number;
  error?: string;
}

export interface ServicesPlatform {
  subscribe(listener: () => void): () => void;
  /** Whether this peer is reachable at all right now. */
  isOnline(): boolean;
  setOnline(online: boolean): Promise<void>;
  getSharedServices(): SharedService[];
  /** Throws with a readable message when the target is not acceptable or access was denied. */
  shareService(name: string, target: string): Promise<void>;
  removeService(id: string): Promise<void>;
  setServiceEnabled(id: string, enabled: boolean): Promise<void>;
  getPeer(peerPubKeyZ32: string): PeerLinkState | null;
  connect(peerPubKeyZ32: string): void;
  openService(peerPubKeyZ32: string, serviceId: string): Promise<void>;
  /** Largest file that can be sent, in bytes. */
  maxFileBytes: number;
  /** Starts sending and returns what to show in the chat. Progress comes through `getTransfer`. */
  sendFile(peerPubKeyZ32: string, file: File): Promise<{ timestamp: number; file: ChatFile }>;
  /** Null when nothing is known about the transfer, e.g. after a restart. */
  getTransfer(fileId: string): FileTransferState | null;
  getFile(fileId: string): Promise<Blob | null>;
  getNetwork(): NetworkSettings | null;
  setNetwork(settings: Pick<NetworkSettings, "relays" | "turn">): Promise<void>;
}

export const servicesPlatform: ServicesPlatform | null = null;

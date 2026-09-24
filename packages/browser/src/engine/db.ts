import { emptyIdentityLedger, emptyProofLedger, type IdentityLedger, type ProofLedger } from "@ghostly/core";
import { STORES, fileStore, store, wrap, openDb } from "../shared/idb";
import type { Settings, StoredGroup, StoredLink, StoredMessage, StoredService } from "../shared/types";

/**
 * Durable local state of the browser peer. Identity seeds live here the same
 * way Desktop keeps them in its WebView storage: local to this profile, never
 * published. Network presence is not stored; it only exists while the engine runs.
 */
export const db = {
  async getLinks(): Promise<StoredLink[]> {
    return wrap((await store(STORES.links, "readonly")).getAll());
  },
  async putLink(link: StoredLink): Promise<void> {
    const tx = (await openDb()).transaction(STORES.links, "readwrite");
    tx.objectStore(STORES.links).put(link);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Link storage failed"));
    });
  },
  async patchLink(linkId: string, patch: Partial<StoredLink>): Promise<void> {
    const tx = (await openDb()).transaction(STORES.links, "readwrite");
    const links = tx.objectStore(STORES.links);
    const request = links.get(linkId);
    request.onsuccess = () => { if (!request.result) { tx.abort(); return; } links.put({ ...request.result, ...patch, id: linkId }); };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Link unavailable"));
    });
  },
  async updatePeerProofs(linkId: string, change: (ledger: ProofLedger) => ProofLedger): Promise<ProofLedger> {
    const tx = (await openDb()).transaction(STORES.links, "readwrite");
    const links = tx.objectStore(STORES.links);
    let result: ProofLedger;
    let failure: unknown;
    const request = links.get(linkId);
    request.onsuccess = () => {
      try {
        const link = request.result as StoredLink | undefined;
        if (!link?.pairedPeerKey) throw new Error("Confirmed conversation unavailable");
        result = change(link.peerProofs ?? emptyProofLedger());
        links.put({ ...link, peerProofs: result });
      } catch (e) { failure = e; tx.abort(); }
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error("Proof storage failed"));
    });
    return result!;
  },
  /** Read-transform-write of a chat's identity ledger in one transaction, keeping every other field. */
  async updateIdentities(linkId: string, change: (ledger: IdentityLedger) => IdentityLedger): Promise<IdentityLedger> {
    const tx = (await openDb()).transaction(STORES.links, "readwrite");
    const links = tx.objectStore(STORES.links);
    let result: IdentityLedger;
    let failure: unknown;
    const request = links.get(linkId);
    request.onsuccess = () => {
      try {
        const link = request.result as StoredLink | undefined;
        if (!link?.profile) throw new Error("Paired chat unavailable");
        result = change(link.identities ?? emptyIdentityLedger());
        links.put({ ...link, identities: result });
      } catch (e) { failure = e; tx.abort(); }
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error("Identity storage failed"));
    });
    return result!;
  },
  async pinPeer(linkId: string, key: string, signedSignals = false): Promise<void> {
    const tx = (await openDb()).transaction(STORES.links, "readwrite");
    const links = tx.objectStore(STORES.links);
    const request = links.get(linkId);
    request.onsuccess = () => {
      const link = request.result as StoredLink | undefined;
      if (!link?.participationSeed || (link.pairedPeerKey && link.pairedPeerKey !== key)) { tx.abort(); return; }
      links.put({ ...link, peerTrust: link.peerTrust ?? { version: 1, verifiedKey: link.pairedPeerKey }, pairedPeerKey: key, requireSignedSignals: link.requireSignedSignals || signedSignals, inviteCode: undefined });
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Invitation already consumed or unavailable"));
    });
  },
  async verifyPeer(linkId: string, key: string): Promise<void> {
    const tx = (await openDb()).transaction(STORES.links, "readwrite");
    const links = tx.objectStore(STORES.links);
    const request = links.get(linkId);
    request.onsuccess = () => {
      const link = request.result as StoredLink | undefined;
      if (!link?.pairedPeerKey || link.pairedPeerKey !== key) { tx.abort(); return; }
      links.put({ ...link, peerTrust: { version: 1, verifiedKey: key, verifiedAt: Date.now() } });
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Contact changed or verification could not be saved"));
    });
  },
  async deleteLink(linkId: string): Promise<void> {
    await wrap((await store(STORES.links, "readwrite")).delete(linkId));
    const messages = await store(STORES.messages, "readwrite");
    const keys = await wrap(messages.index("byLink").getAllKeys(linkId));
    await Promise.all(keys.map((key) => wrap(messages.delete(key))));
    await fileStore.deleteForLink(linkId);
  },

  async getMessages(linkId: string): Promise<StoredMessage[]> {
    const messages = await wrap<StoredMessage[]>((await store(STORES.messages, "readonly")).index("byLink").getAll(linkId));
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  },
  /** Returns false when the message was already stored. */
  async addMessage(message: StoredMessage): Promise<boolean> {
    const tx = (await openDb()).transaction(STORES.messages, "readwrite");
    const messages = tx.objectStore(STORES.messages);
    let added = false;
    const request = messages.getKey([message.linkId, message.id]);
    request.onsuccess = () => {
      if (request.result !== undefined) return;
      messages.put(message);
      added = true;
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Message storage failed"));
    });
    return added;
  },
  async updateDelivery(linkId: string, id: string, delivery: NonNullable<StoredMessage["delivery"]>, deliveryError?: string): Promise<void> {
    const tx = (await openDb()).transaction(STORES.messages, "readwrite");
    const messages = tx.objectStore(STORES.messages);
    const request = messages.get([linkId, id]);
    request.onsuccess = () => {
      const message = request.result as StoredMessage | undefined;
      // Receipts are terminal; timeout/disconnect/send races cannot undo them.
      // Do not resurrect deleted messages or attach new states to old history.
      if (!message?.delivery || message.delivery === "delivered") return;
      messages.put({ ...message, delivery, deliveryError });
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Receipt storage failed"));
    });
  },
  async deleteMessage(linkId: string, messageId: string): Promise<void> {
    await wrap((await store(STORES.messages, "readwrite")).delete([linkId, messageId]));
  },

  async getGroups(): Promise<StoredGroup[]> {
    return wrap((await store(STORES.groups, "readonly")).getAll());
  },
  async putGroup(group: StoredGroup): Promise<void> {
    await wrap((await store(STORES.groups, "readwrite")).put(group));
  },
  /** The group and its history. */
  async deleteGroup(groupId: string): Promise<void> {
    await wrap((await store(STORES.groups, "readwrite")).delete(groupId));
    const messages = await store(STORES.messages, "readwrite");
    const keys = await wrap(messages.index("byLink").getAllKeys(`group:${groupId}`));
    await Promise.all(keys.map((key) => wrap(messages.delete(key))));
  },

  async getServices(): Promise<StoredService[]> {
    return wrap((await store(STORES.services, "readonly")).getAll());
  },
  async putService(service: StoredService): Promise<void> {
    await wrap((await store(STORES.services, "readwrite")).put(service));
  },
  async deleteService(serviceId: string): Promise<void> {
    await wrap((await store(STORES.services, "readwrite")).delete(serviceId));
  },

  async getSettings(): Promise<Partial<Settings>> {
    return (await wrap((await store(STORES.settings, "readonly")).get("settings"))) ?? {};
  },
  async putSettings(settings: Settings): Promise<void> {
    await wrap((await store(STORES.settings, "readwrite")).put(settings, "settings"));
  },
};

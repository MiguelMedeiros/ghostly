import { emptyIdentityLedger, emptyProofLedger, type IdentityLedger, type ProofLedger } from "@ghostly/core";
import { STORES, fileStore, store, wrap, openDb } from "../shared/idb";
import { removeFileBytes } from "../shared/fileBytes";
import type { MessagePage, Settings, StoredGroup, StoredLink, StoredMessage, StoredService } from "../shared/types";

/**
 * The newest `count` rows of an index range, newest first: one descending read where IndexedDB has it (the options
 * that came with `getAllRecords`), else a cursor from the end.
 */
function newestMessages(index: IDBIndex, query: IDBKeyRange, count: number): Promise<StoredMessage[]> {
  if (typeof (index as { getAllRecords?: unknown }).getAllRecords === "function") {
    const descending = index as unknown as { getAll(options: { query: IDBKeyRange; count: number; direction: IDBCursorDirection }): IDBRequest<StoredMessage[]> };
    return wrap(descending.getAll({ query, count, direction: "prev" }));
  }
  return new Promise((resolve, reject) => {
    const rows: StoredMessage[] = [];
    const request = index.openCursor(query, "prev");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) rows.push(cursor.value as StoredMessage);
      if (!cursor || rows.length >= count) resolve(rows);
      else cursor.continue();
    };
  });
}

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
    await removeFileBytes(`${linkId}-in-`);
    await removeFileBytes(`${linkId}-out-`);
  },

  async getMessages(linkId: string): Promise<StoredMessage[]> {
    const messages = await wrap<StoredMessage[]>((await store(STORES.messages, "readonly")).index("byLink").getAll(linkId));
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  },
  /** Whether the chat has a message with this id. */
  async hasMessage(linkId: string, id: string): Promise<boolean> {
    return (await wrap((await store(STORES.messages, "readonly")).getKey([linkId, id]))) !== undefined;
  },
  async getMessage(linkId: string, id: string): Promise<StoredMessage | undefined> {
    return wrap((await store(STORES.messages, "readonly")).get([linkId, id]));
  },
  /**
   * The newest `limit` messages of a chat before `before`, oldest first, in `getMessages`' order (time, then id), and
   * whether older ones remain. Reads those rows only: a long chat's first page costs what a short one's does.
   * `before`: a message's place (the page ends just before it), or a time (`id` left out: the page ends before it).
   */
  async getMessagePage(linkId: string, { limit, before }: { limit: number; before?: { timestamp: number; id?: string } }): Promise<MessagePage> {
    const range = IDBKeyRange.bound([linkId, -Infinity], [linkId, before?.timestamp ?? Infinity], false, !!before && before.id === undefined);
    // Messages of `before`'s time from it on are in the range but not before it: read past them.
    const kept = (m: StoredMessage) => !(before?.id !== undefined && m.timestamp === before.timestamp && m.id >= before.id);
    for (let want = limit + 1; ;) {
      const newest = await newestMessages((await store(STORES.messages, "readonly")).index("byLinkTime"), range, want);
      const page = newest.filter(kept);
      if (page.length > limit || newest.length < want) return { messages: page.slice(0, limit).reverse(), more: page.length > limit };
      want += newest.length - page.length;
    }
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
  /** Writes a message whether or not it is there: lines of history that change as what they tell changes. */
  async putMessage(message: StoredMessage): Promise<void> {
    await wrap((await store(STORES.messages, "readwrite")).put(message));
  },
  async updateDelivery(linkId: string, id: string, delivery: NonNullable<StoredMessage["delivery"]>, deliveryError?: string, extra?: Partial<Pick<StoredMessage, "via" | "resendUntil">>): Promise<void> {
    const tx = (await openDb()).transaction(STORES.messages, "readwrite");
    const messages = tx.objectStore(STORES.messages);
    const request = messages.get([linkId, id]);
    request.onsuccess = () => {
      const message = request.result as StoredMessage | undefined;
      // Receipts are terminal; timeout/disconnect/send races cannot undo them.
      // Do not resurrect deleted messages or attach new states to old history.
      if (!message?.delivery || message.delivery === "delivered") return;
      messages.put({ ...message, ...extra, delivery, deliveryError });
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Receipt storage failed"));
    });
  },
  /**
   * Changes one message row in place, in one transaction: `change` sees the row as stored and gives the fields to
   * set (`null`: leave it). A row that is not there is not made. Used for what the delivery states do not carry
   * (the message's details record), on rows in any state.
   */
  async patchMessage(linkId: string, id: string, change: (message: StoredMessage) => Partial<StoredMessage> | null): Promise<StoredMessage | undefined> {
    const tx = (await openDb()).transaction(STORES.messages, "readwrite");
    const messages = tx.objectStore(STORES.messages);
    const request = messages.get([linkId, id]);
    let result: StoredMessage | undefined;
    request.onsuccess = () => {
      const message = request.result as StoredMessage | undefined;
      if (!message) return;
      const patch = change(message);
      if (!patch) return;
      result = { ...message, ...patch };
      messages.put(result);
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Message storage failed"));
    });
    return result;
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

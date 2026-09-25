import {
  isPubkyKey, isPubkyProofFolder, newPubkyProofFolder, normalizePubkyKey, pubkyProofCapability, pubkyProofFile, pubkyProofPath,
} from "@ghostly/core";
import type { IdentityPlatform, IdentityProofProvider, InAppSigner } from "../contract";
import { readPubkyFile, withPubkyApproval, type PubkyApprovalOptions } from "../pubky";

/**
 * A Pubky identity (WISP 302, docs/wisps/302-pubky.md), proven by publication: Pubky Ring and Pubky Passport sign
 * only standard Pubky auth requests, so Ghostly asks, in ONE request either of them can approve, for write access to
 * one fresh folder of the key's homeserver (`/pub/ghostly.app/proofs/<random>/`), and writes the identity statement
 * there. Contacts' apps read the file back from the homeserver the key's own signed Pkarr records name. The session
 * is used once, in memory, and signed out; removing the proof needs a new approval to delete the file.
 */
export interface PubkyEvidence { folder: string }

const short = (key: string) => `pubky${key.slice(0, 4)}…${key.slice(-4)}`;

export interface PubkyIdentityOptions {
  /** Pkarr relays the verifier reads (tests). */
  relays?: readonly string[];
  /** The approval flow's knobs (tests: a local relay, a Passport stand-in). */
  approval?: Partial<Pick<PubkyApprovalOptions, "relay" | "timeoutMs" | "openPassport">>;
}

export function createPubkyIdentityProvider(options: PubkyIdentityOptions = {}): IdentityProofProvider<PubkyEvidence> {
  const approve = <T>(capability: `/pub/${string}/:w`, ctx: Parameters<InAppSigner<PubkyEvidence>["run"]>[0], work: Parameters<typeof withPubkyApproval<T>>[1]) => {
    if (!ctx.onApproval) throw new Error("This screen cannot show a Pubky request");
    return withPubkyApproval({ ...options.approval, capability, signal: ctx.signal, onApproval: ctx.onApproval, onProgress: ctx.onProgress }, work);
  };

  const signer: InAppSigner<PubkyEvidence> = {
    id: "pubky-auth", kind: "in-app",
    label: "Pubky Ring or Pubky Passport",
    description: "One request: approve it in Pubky Passport in your browser, or scan it with Pubky Ring. Ghostly only asks to write one small file to a new folder of your homeserver.",
    run(ctx, work) {
      const folder = newPubkyProofFolder();
      return approve(pubkyProofCapability(folder), ctx, async session => {
        let written: `/pub/${string}` | undefined;
        try {
          return await work({
            subject: async () => session.key,
            async sign(statement) {
              if (statement.binding.subject !== session.key) throw new Error("That is another Pubky identity");
              ctx.onProgress("Writing the proof to your homeserver…");
              const path = pubkyProofPath(folder, statement.id);
              await session.put(path, pubkyProofFile(statement));
              written = path;
              return { folder };
            },
          });
        } catch (e) {
          // Not saved (a failed check, a cancel): the file does not stay behind.
          if (written) await session.delete(written).catch(() => {});
          throw e;
        }
      });
    },
  };

  return {
    id: "pubky",
    label: "Pubky",
    category: "self-custodied",
    summary: "Approve in Pubky Ring or Passport",
    description: "Proves you hold a Pubky key: approve one request in Pubky Ring or Pubky Passport, and Ghostly writes a small proof file to your homeserver. Contacts’ apps read it back through your key’s own records.",
    limits: "The file is on your homeserver: whoever runs it could write there too. It does not prove who holds the key.",
    platforms: ["web", "extension", "desktop"] satisfies IdentityPlatform[],
    subject: {
      label: "Pubky key",
      placeholder: "pubky…",
      help: "Comes from Pubky Ring or Passport when you approve.",
      normalize: normalizePubkyKey,
      short,
    },
    validity: { defaultDays: 90, maxDays: 365 },
    // The file can be deleted, or the key can move to another homeserver, before the proof expires.
    recheck: { afterSeconds: 86_400 },
    privacy: "Your contact’s app reads your key’s records from Pubky’s Pkarr relays (pkarr.pubky.org, pkarr.pubky.app) and the proof file from your homeserver, which sees the contact’s IP address.",
    signers: [signer],
    parseEvidence(raw) {
      const e = raw as PubkyEvidence;
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).join(",") !== "folder" || !isPubkyProofFolder(e.folder))
        throw new Error("That is not Pubky proof evidence");
      return { folder: e.folder };
    },
    async verify(statement, { folder }, ctx) {
      const key = statement.binding.subject;
      if (!isPubkyKey(key)) throw new Error("That is not a Pubky key");
      const { text, host } = await readPubkyFile(key, pubkyProofPath(folder, statement.id), ctx.fetch, ctx.signal, options.relays);
      if (text === undefined) throw new Error("The proof file is not on the homeserver");
      if (text !== pubkyProofFile(statement)) throw new Error("The file on the homeserver is not this proof");
      return { subject: key, source: `File on the homeserver ${host}, found through the key’s own Pkarr records` };
    },
    unpublish: {
      label: "Approve and remove",
      description: "The proof file stays on your homeserver until it is deleted, and deleting it needs one more approval in Pubky Ring or Passport: Ghostly kept no access. Either way, a revocation is published that contacts check.",
      run({ statement, evidence }, ctx) {
        const path = pubkyProofPath(evidence.folder, statement.id);
        return approve(pubkyProofCapability(evidence.folder), ctx, async session => {
          if (session.key !== statement.binding.subject) throw new Error("That is another Pubky identity: approve with the one this proof is for");
          ctx.onProgress("Deleting the proof file from your homeserver…");
          await session.delete(path);
        });
      },
    },
  };
}

export const pubky = createPubkyIdentityProvider();

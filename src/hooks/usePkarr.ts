import { useState, useCallback } from "react";
import { createKeypair, getPublicKeyFromSeed } from "../lib/pkarr";
import { generateEncryptionKey } from "../lib/crypto";
import { buildCreatorUrl, buildInviteCode, buildInviteUrl } from "../lib/url";

interface DropResult {
  creatorUrl: string;
  inviteUrl: string;
  inviteCode: string;
  seedA: string;
  seedB: string;
  pubKeyA: string;
  pubKeyB: string;
  encKey: string;
}

export function usePkarr() {
  const [isCreating, setIsCreating] = useState(false);

  const createDrop = useCallback(async (): Promise<DropResult> => {
    setIsCreating(true);
    try {
      const keypairA = await createKeypair();
      const keypairB = await createKeypair();
      const encKey = await generateEncryptionKey();

      const origin = window.location.origin;
      const creatorUrl = buildCreatorUrl(
        origin,
        keypairA.seedB64,
        keypairB.pubKeyZ32,
        encKey,
      );
      const inviteCode = buildInviteCode(
        keypairB.seedB64,
        keypairA.pubKeyZ32,
        encKey,
      );
      const inviteUrl = buildInviteUrl(
        origin,
        keypairB.seedB64,
        keypairA.pubKeyZ32,
        encKey,
      );

      return {
        creatorUrl,
        inviteUrl,
        inviteCode,
        seedA: keypairA.seedB64,
        seedB: keypairB.seedB64,
        pubKeyA: keypairA.pubKeyZ32,
        pubKeyB: keypairB.pubKeyZ32,
        encKey,
      };
    } finally {
      setIsCreating(false);
    }
  }, []);

  return { createDrop, isCreating, getPublicKeyFromSeed };
}

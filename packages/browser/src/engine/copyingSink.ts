import type { KeptPictures, PostedEvent } from "../shared/rpc";
import type { EngineState } from "../shared/types";
import type { EngineClientSink } from "./server";

/**
 * A client whose messages are copied on their way (the extension's port): every state used to carry every payment
 * this device kept and the whole wallet, copied each time, up to 20 times a second. `payments` and `wallet` are the
 * same objects until one changes (`PaymentBook`, `walletView`): a state whose own are the ones this client was sent
 * last leaves them out, and the page keeps those (`PostedState`). The first state always carries them.
 *
 * So does each picture: the profile's own, every contact's and every group's (a JPEG data URL each, up to 48 KB) were most
 * of a state's bytes, and went again with each one. One this client was sent last under the same name is left out
 * (`keptPictures`); a new one, or one back after a state without it, goes.
 */
export function copyingSink(post: (message: PostedEvent) => void): EngineClientSink {
  let sent: Pick<EngineState, "payments" | "wallet"> | null = null;
  let pictures = new Map<string, string>();
  return {
    post: (message) => {
      if (message.kind !== "state") return post(message);
      const { payments, wallet, settings, links, edges, groups, ...rest } = message.state;
      const now = new Map<string, string>();
      const kept: KeptPictures = {};
      // Whether this picture is the one sent last under this name (an id is once in its list: the engine's links and
      // groups are kept by id, a community member's pay link is named by group and member).
      const same = (name: string, picture: string | undefined): boolean => {
        if (!picture) return false;
        now.set(name, picture);
        return pictures.get(name) === picture;
      };
      const leaveOut = <T extends { id: string }>(list: T[], kind: "links" | "edges" | "groups", field: keyof T & ("peerAvatar" | "picture")): T[] =>
        list?.map((item) => {
          if (!same(`${kind}:${item.id}`, item[field] as string | undefined)) return item;
          (kept[kind] ??= []).push(item.id);
          const { [field]: _, ...without } = item;
          return without as T;
        });
      const ownKept = same("avatar", settings?.avatar);
      if (ownKept) kept.avatar = true;
      post({ kind: "state", state: {
        ...rest,
        settings: ownKept ? (({ avatar: _, ...without }) => without)(settings) : settings,
        links: leaveOut(links, "links", "peerAvatar"),
        ...(edges && { edges: leaveOut(edges, "edges", "peerAvatar") }),
        groups: leaveOut(groups, "groups", "picture"),
        ...(sent && payments === sent.payments ? {} : { payments }),
        ...(sent && wallet === sent.wallet ? {} : { wallet }),
        ...(Object.keys(kept).length ? { keptPictures: kept } : {}),
      } });
      sent = { payments, wallet };
      pictures = now;
    },
  };
}

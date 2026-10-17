import { node, state, str, type ApiContext, type Method } from "./apiKit";
import { CliError } from "./errors";

/**
 * The profile's contact link and its requests (WISP 8xx): one link at a time, made, shown and turned off here; the
 * requests it took listed, accepted (the chat starts) or declined (nothing is said back). A request is named by its
 * id or a unique prefix of it, as `requests list` prints it.
 */

function requestId(ctx: ApiContext, ref: string): string {
  const requests = state(ctx).contactRequests ?? [];
  const exact = requests.find((r) => r.id === ref);
  if (exact) return exact.id;
  const matches = ref.length >= 4 ? requests.filter((r) => r.id.startsWith(ref)) : [];
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new CliError("bad_request", `${JSON.stringify(ref)} names ${matches.length} requests: give more of its id`);
  throw new CliError("not_found", `No request ${JSON.stringify(ref)} waiting (ghostly requests list)`);
}

export const CONTACT_LINK_METHODS: Record<string, Method> = {
  async "contact-link.create"(ctx) {
    return { contactLink: await node(ctx).createContactLink() };
  },

  async "contact-link.show"(ctx) {
    return { contactLink: state(ctx).contactLink ?? null };
  },

  async "contact-link.off"(ctx) {
    if (!state(ctx).contactLink) throw new CliError("not_found", "This profile has no contact link (ghostly contact-link create)");
    await node(ctx).turnOffContactLink();
    return { off: true };
  },

  /** Looks at the link's knock slots first, so a one-shot lists what came while no daemon ran. */
  async "requests.list"(ctx) {
    const link = state(ctx).contactLink;
    if (!link) throw new CliError("not_found", "This profile has no contact link (ghostly contact-link create)");
    await node(ctx).contactLinks.poll();
    const after = state(ctx);
    return { requests: after.contactRequests ?? [], missed: after.contactLink?.missed ?? 0, state: after.contactLink?.state ?? link.state };
  },

  async "requests.accept"(ctx, params) {
    const id = requestId(ctx, str(params, "request", true));
    try {
      const { linkId } = await node(ctx).acceptContactRequest({ id });
      return { accepted: id, chat: linkId };
    } catch (error) {
      throw new CliError("refused", error instanceof Error ? error.message : String(error));
    }
  },

  async "requests.decline"(ctx, params) {
    const id = requestId(ctx, str(params, "request", true));
    await node(ctx).declineContactRequest({ id });
    return { declined: id };
  },
};

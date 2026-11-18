import { bool, list, str, type Method, type Params } from "../apiKit";
import { CliError } from "../errors";

/**
 * The call a method names (a chat, or a call's id): left out, the only call. Given as "" or blank (an unset variable in
 * a script), it names none and is refused: `str` reads "" as left out, so it hung up, answered or flushed whatever call
 * was on.
 */
function callRef(params: Params): string | undefined {
  const call = params.call;
  if (typeof call === "string" && !call.trim()) throw new CliError("bad_request", `call ${JSON.stringify(call)} names no chat or call: name one, or leave it out for the only call`);
  return str(params, "call");
}

/** Voice calls (WISP 1100 § Calls): the API methods. The audio itself goes over each call's own socket. */
export const CALL_METHODS: Record<string, Method> = {
  async "call.start"(ctx, params) {
    return ctx.calls.start(str(params, "chat", true), { rate: params.rate });
  },
  async "call.answer"(ctx, params) {
    return ctx.calls.answer(callRef(params), { rate: params.rate });
  },
  async "call.hangup"(ctx, params) {
    return ctx.calls.hangup(callRef(params));
  },
  async "call.list"(ctx) {
    return { calls: ctx.calls.list(), autoAnswer: ctx.calls.getAuto(), available: ctx.runtime.callsUnavailable === null, ...(ctx.runtime.callsUnavailable ? { unavailable: ctx.runtime.callsUnavailable } : {}) };
  },
  async "call.get"(ctx, params) {
    return ctx.calls.get(callRef(params));
  },
  async "call.flush"(ctx, params) {
    return ctx.calls.flush(callRef(params));
  },
  async "call.auto"(ctx, params) {
    const on = params.on === undefined ? undefined : bool(params, "on");
    // The chats and the rate go with on: true, as `call auto --from` refuses them without on: before, from with on:
    // false turned auto-answer off for every chat, and from alone only read the setting, each without a word.
    if (on !== true && (list(params, "from").length > 0 || (params.rate !== undefined && params.rate !== null))) throw new CliError("bad_request", "from and rate go with on: true");
    if (on === undefined) return { autoAnswer: ctx.calls.getAuto() };
    return { autoAnswer: ctx.calls.setAuto({ on, from: list(params, "from"), rate: params.rate }) };
  },
};

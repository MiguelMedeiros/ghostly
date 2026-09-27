import { bool, list, str, type Method } from "../apiKit";

/** Voice calls (WISP 11xx § Calls): the API methods. The audio itself goes over each call's own socket. */
export const CALL_METHODS: Record<string, Method> = {
  async "call.start"(ctx, params) {
    return ctx.calls.start(str(params, "chat", true), { rate: params.rate });
  },
  async "call.answer"(ctx, params) {
    return ctx.calls.answer(str(params, "call"), { rate: params.rate });
  },
  async "call.hangup"(ctx, params) {
    return ctx.calls.hangup(str(params, "call"));
  },
  async "call.list"(ctx) {
    return { calls: ctx.calls.list(), autoAnswer: ctx.calls.getAuto(), available: ctx.runtime.callsUnavailable === null, ...(ctx.runtime.callsUnavailable ? { unavailable: ctx.runtime.callsUnavailable } : {}) };
  },
  async "call.flush"(ctx, params) {
    return ctx.calls.flush(str(params, "call"));
  },
  async "call.auto"(ctx, params) {
    if (params.on === undefined) return { autoAnswer: ctx.calls.getAuto() };
    return { autoAnswer: ctx.calls.setAuto({ on: bool(params, "on"), from: list(params, "from"), rate: params.rate }) };
  },
};

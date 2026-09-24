import { useCallback, useEffect, useMemo } from "react";
import { useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import {
  HOME, conversationTarget, hasParent, homeTarget, openTarget, openUnderTarget, placeTarget, plan, readNav, stackOf, upTarget, userState,
  type NavEntry, type NavPlan,
} from "../lib/navigation";

/**
 * What is left of a plan once the history has gone back: going back is asynchronous (the browser answers
 * with a popstate), so the replace and pushes wait for the location to change. Whichever mounted user of
 * the hook sees the change first runs them. A pop that never lands is not run on some later change.
 */
let pending: { from: string; at: number; run: (navigate: NavigateFunction) => void } | null = null;
const PENDING_MS = 1500;

function execute(navigate: NavigateFunction, fromKey: string, steps: NavPlan) {
  const rest = (nav: NavigateFunction) => {
    if (steps.replace) nav(steps.replace.path, { replace: true, state: steps.replace.state });
    for (const step of steps.push) nav(step.path, { state: step.state });
  };
  if (steps.back > 0) {
    pending = { from: fromKey, at: Date.now(), run: rest };
    void navigate(-steps.back);
  } else rest(navigate);
}

/**
 * The app's ways to move (see `lib/navigation.ts` for the hierarchy):
 * - `home()`: the chat list with New and Join.
 * - `conversation(path)`: a chat or a group, from the sidebar, a notification, a link.
 * - `place(path)`: the account bar's and the tab bar's pages.
 * - `open(path)`: a page opened from inside the current one; its Back comes back here.
 * - `up()`: a page's Back button. `hasParent` says whether it goes to a parent page rather than home.
 */
export function useAppNavigation() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!pending || pending.from === location.key) return;
    const { run, at } = pending;
    pending = null;
    if (Date.now() - at < PENDING_MS) run(navigate);
  }, [location.key, navigate]);

  const stack = useMemo(() => stackOf(location.pathname, location.state), [location.pathname, location.state]);
  const to = useCallback((target: NavEntry[], state?: Record<string, unknown>) => {
    if (pending && Date.now() - pending.at < PENDING_MS) return; // still on the way somewhere
    execute(navigate, location.key, plan(stack, target, state));
  }, [navigate, location.key, stack]);

  return useMemo(() => ({
    home: () => to(homeTarget()),
    conversation: (path: string, state?: Record<string, unknown>) => to(conversationTarget(path), state),
    place: (path: string, state?: Record<string, unknown>) => to(placeTarget(stack, path), state),
    open: (path: string, state?: Record<string, unknown>) => to(openTarget(stack, path), state),
    openUnder: (parent: string, path: string, state?: Record<string, unknown>) => to(openUnderTarget(parent, path), state),
    up: () => to(upTarget(stack)),
    hasParent: hasParent(stack),
  }), [to, stack]);
}

/**
 * An entry that says nothing about what is under it — the app opened on a deep link (`#/chat/…`,
 * `#/group/…`, `#/wallet`), an address typed in, the page a profile switch reloads on — gets home put
 * under it, so its Back and the browser's lead home rather than out of the app. Addresses the intakes
 * rewrite (an invite's keys, a group link) are left to them. Mounted once, inside the router.
 */
export function useAnchorHome(isIntake: (pathname: string) => boolean) {
  const navigate = useNavigate();
  const { pathname, state, key } = useLocation();
  useEffect(() => {
    if (pathname === HOME || readNav(state) || isIntake(pathname)) return;
    const stack = stackOf(pathname, state);
    execute(navigate, key, plan(stack, [{ path: HOME }, { path: pathname }], userState(state)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per entry
  }, [key]);
}

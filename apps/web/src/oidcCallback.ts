import { OIDC_CHANNEL, routeCallback } from "@ghostly/browser/proofs/oidc/popup";

/**
 * Where a provider sends the person back after signing in for an identity
 * proof. Static: the answer sits in the fragment, which no server sees. This
 * page hands it to the Ghostly tab that asked, to the desktop app's listener
 * on this machine, or to the Android app by its deep link, and keeps no copy.
 */
const message = document.getElementById("message")!;
const route = routeCallback(location.href);
if (route.kind === "desktop") {
  // Replaces this history entry, so the answer is not left behind in it.
  location.replace(route.target);
} else if (route.kind === "app") {
  history.replaceState(null, "", location.pathname);
  location.replace(route.target);
  // A browser may want a tap before it opens an app: the same link, to tap.
  const open = document.createElement("a");
  open.href = route.target;
  open.textContent = "Open Ghostly";
  open.style.color = "inherit";
  message.textContent = "";
  message.append(open);
} else {
  history.replaceState(null, "", location.pathname);
  if (route.kind === "tab") {
    const channel = new BroadcastChannel(OIDC_CHANNEL);
    channel.postMessage({ type: OIDC_CHANNEL, url: route.url });
    channel.close();
    message.textContent = "Done. You can close this window.";
    setTimeout(() => window.close(), 300);
  } else message.textContent = "Nothing to do here.";
}

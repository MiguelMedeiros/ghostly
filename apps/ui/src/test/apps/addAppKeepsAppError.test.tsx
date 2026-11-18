import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddAppDialog } from "../../components/apps/AddAppDialog";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import type { AppStorePreview } from "@ghostly/browser/engine/apps";

// covers: apps.page

const REPO = "https://github.com/ana/chess";
// The engine's own words for a link with no store file (`.../HEAD/ghostly-store.json`).
const NO_STORE = "status: The host answered 404";

const store = ({ url }: { url: string }): AppStorePreview => ({ url, key: "k", name: "Ana's store", kind: "curated", sequence: 1,
  apps: 1, fingerprint: "abcd efgh", expires: 9e9, expired: false });

afterEach(() => { vi.restoreAllMocks(); });

/** Add on the repository's link, the app read answering `app` and the store read `onStore`: what was read, in order. */
async function check(app: string, onStore: (params: { url: string }) => AppStorePreview) {
  const tried: string[] = [];
  fakeEngine.on("appPreview", () => { tried.push("app"); throw new Error(app); })
    .on("appStorePreview", (params) => { tried.push("store"); return onStore(params as { url: string }); });
  const view = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
  await view.user.type(screen.getByTestId("apps-add-url"), REPO);
  await view.user.click(screen.getByTestId("apps-add-check"));
  return { tried, ...view };
}

describe("Add, a repository link whose app was refused: the app's own words, not the missing store's", () => {
  it.each([
    ["too large", "too-large: Too large", "Too large."],
    ["not signed correctly", "bad-signature: This is not an app Ghostly can install", "Not signed correctly. Ghostly won't install it."],
    ["too slow", "slow: That took too long on this connection", "That took too long on this connection. Try again on a faster one."],
    // Its Try again later stays: the host's trouble may pass.
    ["the host's 503", "status: The host answered 503", "The host had a problem (error 503). Try again later."],
  ])("%s", async (_, refused, words) => {
    const { tried } = await check(refused, () => { throw new Error(NO_STORE); });
    const error = await screen.findByTestId("apps-add-error");
    expect(error).toHaveTextContent(words);
    expect(error).not.toHaveTextContent("Nothing found at that link.");
    // Something is there, and it is an app: the link is not read again as a store.
    expect(tried).toEqual(["app"]);
  });
});

describe("Add, a repository link with no app: read as a store", () => {
  it("no app file (404) and a store there: the store's question opens", async () => {
    const { tried } = await check("status: The host answered 404", store);
    expect(await screen.findByTestId("apps-add-store")).toHaveTextContent("Ana's store");
    expect(screen.queryByTestId("apps-add-error")).not.toBeInTheDocument();
    expect(tried).toEqual(["app", "store"]);
  });

  it("a file that is no bundle and a store there: the store's question opens", async () => {
    const { tried } = await check("magic: This is not an app Ghostly can install", store);
    expect(await screen.findByTestId("apps-add-store")).toHaveTextContent("Ana's store");
    expect(tried).toEqual(["app", "store"]);
  });

  it("no app file (404) and no store file (404): nothing found at that link", async () => {
    const { tried } = await check("status: The host answered 404", () => { throw new Error(NO_STORE); });
    expect(await screen.findByTestId("apps-add-error")).toHaveTextContent("Nothing found at that link.");
    expect(tried).toEqual(["app", "store"]);
  });

  it("a file that is no bundle and no store file (404): the app's refusal, its reason behind the ⓘ", async () => {
    const { user } = await check("magic: This is not an app Ghostly can install", () => { throw new Error(NO_STORE); });
    const error = await screen.findByTestId("apps-add-error");
    expect(error).toHaveTextContent("Ghostly won't install it");
    expect(error).not.toHaveTextContent("Nothing found at that link.");
    await user.click(screen.getByTestId("apps-add-error-info"));
    expect(screen.getByTestId("apps-add-error-details")).toHaveTextContent("This is not an app Ghostly can install");
  });

  it("no app file (404) and a store file that is no store: the store's refusal, as before", async () => {
    await check("status: The host answered 404", () => { throw new Error("not-json: This is not a store Ghostly can read"); });
    expect(await screen.findByTestId("apps-add-error-title")).toHaveTextContent("That link holds no valid store.");
  });
});

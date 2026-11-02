import { beforeEach, describe, expect, it } from "vitest";
import { OPENED_KEY, openedServices, type Opened } from "../../lib/openedServices";

// covers: services.desktop-viewer, services.web-open

/**
 * The list of the contacts' apps this device opened (lib/openedServices.ts), which the web app and Desktop each keep
 * in the shape that names their origins, and clear their own way.
 */
interface Entry extends Opened { name: string }
const list = () => openedServices<Entry>((o) => typeof o.name === "string" && o.name !== "", (a, b) => a.name === b.name);

describe("the contacts' apps this device opened", () => {
  beforeEach(() => localStorage.clear());

  it("are noted once each, every profile's in one list outside any profile's keys", () => {
    const opened = list();
    opened.note({ profile: "", tag: "t1", name: "a" });
    opened.note({ profile: "work000001", tag: "t2", name: "b" });
    opened.note({ profile: "", tag: "t1", name: "a" });
    expect(opened.list()).toEqual([{ profile: "", tag: "t1", name: "a" }, { profile: "work000001", tag: "t2", name: "b" }]);
    expect(OPENED_KEY.startsWith("ghostly_")).toBe(false);
  });

  it("are cleared one at a time, by chat or by profile; one not cleared stays, and the list goes once empty", async () => {
    const opened = list();
    for (const name of ["a", "b", "c"]) opened.note({ profile: "", tag: "t1", name });
    opened.note({ profile: "work000001", tag: "t2", name: "w" });
    const asked: string[] = [];
    await opened.forget({ tag: "t1" }, async ({ name }) => {
      asked.push(name);
      if (name === "b") throw new Error("refused");
      return name === "a";
    });
    expect(asked).toEqual(["a", "b", "c"]);
    expect(opened.list().map((o) => o.name)).toEqual(["b", "c", "w"]);
    await opened.forget({ profile: "work000001" }, async () => true);
    await opened.forget({ profile: "" }, async () => true);
    expect(localStorage.getItem(OPENED_KEY)).toBeNull();
  });

  it("reads past a list that is not one, and entries of another shape", () => {
    localStorage.setItem(OPENED_KEY, "{");
    expect(list().list()).toEqual([]);
    localStorage.setItem(OPENED_KEY, JSON.stringify([{ profile: "", tag: "t", name: "" }, { profile: 1, tag: "t", name: "a" }, null, "a"]));
    expect(list().list()).toEqual([]);
  });
});

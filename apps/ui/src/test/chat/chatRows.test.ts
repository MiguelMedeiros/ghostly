import { describe, expect, it } from "vitest";
import { readContactNick, rowPicker, type NickRead, type NickRow } from "../../lib/chatRows";

const row = (n: number, patch: Partial<NickRow> = {}): NickRow => ({ id: `peer_${n}`, sender: "peer", text: `m${n}`, ...patch });

/** Each field read of a row counts: what a new list costs, whatever the rows hold. */
function counted(rows: NickRow[]) {
  const reads = { n: 0 };
  return { reads, rows: rows.map(m => new Proxy(m, { get(target, key, receiver) { reads.n++; return Reflect.get(target, key, receiver); } })) };
}

/** What the page walked for each list: the whole history, from the newest back. */
function wholeNick(rows: readonly NickRow[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i]!;
    if (m.sender !== "peer" && !(m.sender === "system" && m.id.startsWith("peer_"))) continue;
    if (m.nick) return m.nick;
    const joined = m.text.match(/^👋 (.+) joined$/)?.[1];
    if (joined) return joined;
  }
  return undefined;
}

/** Lists a chat can go through, each from the one before, the same ones on every run. */
function changes() {
  let seed = 42, next = 0;
  const pick = (n: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % n; };
  const steps: ((l: NickRow[]) => NickRow[])[] = [
    l => [...l, row(next++)],
    l => [...l, row(next++, { sender: "me", id: `me_${next}` })],
    l => [...l, row(next++, { nick: `nick${next}` })],
    l => [...l, row(next++, { sender: "system", text: `👋 joiner${next} joined` })],
    l => [...l, row(next++, { sender: "system", id: `sys_${next}`, text: "👋 nobody joined" })],
    // The newest rows read again from storage, as new objects.
    l => [...l.slice(0, -5), ...l.slice(-5).map(m => ({ ...m }))],
    // A row deleted, the one that named the contact too.
    l => (l.length ? l.filter((_, i) => i !== pick(l.length)) : l),
    l => { const last = [...l].reverse().find(m => m.nick); return last ? l.filter(m => m !== last) : l; },
    // An old row changed in place in the list: a new object.
    l => (l.length ? l.map((m, i) => (i === pick(l.length) ? { ...m, text: "edited" } : m)) : l),
    // Older history coming in above.
    l => [row(next++), ...l],
    // Another chat.
    () => (pick(8) ? [] : [row(next++)]),
  ];
  return (list: NickRow[]) => steps[pick(steps.length)](list);
}

describe("rowPicker", () => {
  const picker = () => rowPicker<NickRow, string>(m => (m.sender === "system" ? undefined : m.id));

  it("reads only the rows from the first that changed, not the chat's whole history", () => {
    const pick = picker();
    const { reads, rows } = counted(Array.from({ length: 1_000 }, (_, i) => row(i)));
    pick(rows);
    expect(reads.n).toBeGreaterThanOrEqual(1_000);
    reads.n = 0;
    const picked = pick([...rows, row(1_000)]);
    expect(picked[picked.length - 1]).toBe("peer_1000");
    expect(reads.n).toBe(0);
  });

  it("gives the same array while nothing in it changed, and never changes one it gave", () => {
    const pick = picker();
    const a = row(1), notice = row(2, { sender: "system" });
    const first = pick([a]);
    expect(pick([a, notice])).toBe(first);
    const second = pick([a, notice, row(3)]);
    expect(second).not.toBe(first);
    expect(first).toEqual(["peer_1"]);
    expect(second).toEqual(["peer_1", "peer_3"]);
  });

  it("gives what a walk of the whole list gives, whatever happens to the list", () => {
    const pick = picker(), change = changes();
    let list: NickRow[] = [], longest = 0;
    for (let i = 0; i < 2_000; i++) {
      list = change(list);
      longest = Math.max(longest, list.length);
      const whole = list.filter(m => m.sender !== "system").map(m => m.id);
      if (JSON.stringify(pick(list)) !== JSON.stringify(whole)) expect.fail(`differs from the whole walk at step ${i}`);
    }
    expect(longest).toBeGreaterThan(30);
  });
});

describe("the contact's name in a chat's rows", () => {
  it("does not walk a history where nobody says a name again for each message", () => {
    const { reads, rows } = counted(Array.from({ length: 1_000 }, (_, i) => row(i)));
    const first = readContactNick(rows);
    expect(first.nick).toBeUndefined();
    reads.n = 0;
    expect(readContactNick([...rows, row(1_000)], first).nick).toBeUndefined();
    expect(reads.n).toBe(0);
  });

  it("does not walk back again to a name said long ago", () => {
    const { reads, rows } = counted([row(0, { nick: "Ann" }), ...Array.from({ length: 1_000 }, (_, i) => row(i + 1))]);
    const first = readContactNick(rows);
    reads.n = 0;
    expect(readContactNick([...rows, row(2_000)], first).nick).toBe("Ann");
    expect(reads.n).toBeLessThan(10);
  });

  it("goes back to the name before when the row that said the last one is deleted", () => {
    const ann = row(0, { nick: "Ann" }), bea = row(2, { nick: "Bea" }), plain = row(1);
    const first = readContactNick([ann, plain, bea]);
    expect(first.nick).toBe("Bea");
    expect(readContactNick([ann, plain], first).nick).toBe("Ann");
  });

  it("takes a name from the contact's joining line, not from mine or another's notice", () => {
    expect(readContactNick([row(1, { sender: "system", text: "👋 Ann joined" })]).nick).toBe("Ann");
    expect(readContactNick([row(1, { sender: "system", id: "sys_1", text: "👋 Ann joined" })]).nick).toBeUndefined();
    expect(readContactNick([row(1, { sender: "me", id: "me_1", nick: "Me" })]).nick).toBeUndefined();
  });

  it("finds what a walk of the whole list finds, whatever happens to the list", () => {
    const change = changes();
    let list: NickRow[] = [], read: NickRead | undefined, named = 0;
    for (let i = 0; i < 2_000; i++) {
      list = change(list);
      read = readContactNick(list, read);
      if (read.nick) named++;
      if (read.nick !== wholeNick(list)) expect.fail(`differs from the whole walk at step ${i}`);
    }
    expect(named).toBeGreaterThan(100);
  });
});

import { expect, it } from "vitest";
import { shownAddress } from "../src/shared/shownAddress";
// covers: settings.network.turn

const said = (rows: [string, string][]) => {
  for (const [url, shown] of rows) {
    expect(shownAddress(url), url).toBe(shown);
    expect(shownAddress(url), url).not.toMatch(/s3cr3t|s3cret|cr3t|t0k|alice/);
  }
};

it("says an address without its user, password, query or fragment, and the rest as given", () => {
  said([
    ["turn:host?token=s3cr3t", "turn:host"],
    ["turns://user:s3cr3t@host:5349", "turns://host:5349"],
    ["turns:user:s3cr3t@turn.example:5349", "turns:turn.example:5349"],
    ["turns:user:s3cr3t@host:5349?transport=tcp", "turns:host:5349"],
    ["stuns:user:s3cr3t@host", "stuns:host"],
    ["stun:host/x", "stun:host/x"],
    ["turn:host:3478?transport=sctp", "turn:host:3478"],
    ["turn:host:3478?transport=udp&s3cr3t", "turn:host:3478"],
    ["turn:[::1]:3478?token=s3cr3t", "turn:[::1]:3478"],
    ["https://turn.example.org", "https://turn.example.org"],
    ["https://user:s3cr3t@turn.example.org/#s3cr3t", "https://turn.example.org/"],
    ["https://alice:s3cret@iroh.lan/?token=t0k", "https://iroh.lan/"],
    ["wss://alice:s3cret@relay.lan/#t0k", "wss://relay.lan/"],
    // Percent-encoded, `%40`, `%23` and `%3F` are no delimiters: `%3F` in the host is the host's text.
    ["turn:user%40x:s3cr3t%23y@host?token=s3cr3t%3F", "turn:host"],
    ["turn:host%3Ftoken=x/", "turn:host%3Ftoken=x/"],
    // A scheme is kept only before `://`, but for turn:, turns:, stun: and stuns:, as typed.
    ["s3cr3t:s3cr3t@host", "host"],
    ["user:pw@relay.example", "relay.example"],
    ["TURN:user:s3cr3t@host/", "TURN:host/"],
    ["Turns://user:s3cr3t@host/", "Turns://host/"],
  ]);
});

it("cuts a user or password at its last @, whatever else it holds", () => {
  said([
    ["turn:s3cr3t:s3@cr3t@host/", "turn:host/"],
    ["turn::s3cr3t@host/", "turn:host/"],
    ["turn:s3cr3t:@host/", "turn:host/"],
    ["turn:@host/", "turn:host/"],
    [`turn:${"s3cr3t".repeat(1700)}:${"s3cr3t".repeat(1700)}@host/`, "turn:host/"],
    // ESC/ANSI and bidi characters in the user go with it.
    ["turn:\u001b[31ms3cr3t‮:s3cr3t@host/", "turn:host/"],
  ]);
});

it("says neither the user nor the query when a ? or # comes before the last @, since that @ may be in either", () => {
  said([
    // The @ in the password: a raw ? or # there.
    ["turn:user:pa#s3cr3t@host", "turn:…"],
    ["turn:user:pa?s3cr3t@host", "turn:…"],
    ["turn:s3#cr3t:s3cr3t@host", "turn:…"],
    ["turn:user:p@ss#w?rd@host/", "turn:…"],
    ["https://alice:s3cr#et@relay.example", "https://…"],
    ["https://alice:s3cr?et@relay.example", "https://…"],
    ["http://alice:s3cr?et@relay.example", "http://…"],
    // The @ in the query or fragment.
    ["turn:host?username=me@example.org&credential=s3cr3t", "turn:…"],
    ["turn:host?token=ab@s3cr3t", "turn:…"],
    ["turn:host#frag@s3cr3t", "turn:…"],
    ["turn:user:s3cr3t@host?x=a@b&token=s3cr3t", "turn:…"],
    ["https://relay.example.org/?user=me@example.org&token=s3cr3t", "https://…"],
    ["https://relay.example.org/#a@s3cr3t", "https://…"],
    // No scheme to keep.
    ["relay.example.org/?user=me@example.org&token=s3cr3t", "…"],
  ]);
});

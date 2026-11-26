import { expect, it } from "vitest";
import { iceServerProblem, iceServerSetting } from "../src/shared/ice";
import type { IceServerSetting } from "../src/shared/types";
// covers: settings.network.turn

it("takes TURN and STUN addresses a browser can use, and says what is wrong with the rest", () => {
  for (const server of [
    { urls: "turn:turn.example.org:3478", username: "u", credential: "c" },
    { urls: "turns:turn.example.org:5349?transport=tcp", username: "u", credential: "c" },
    { urls: "stun:stun.example.org:3478" },
    { urls: "stun:a.example.org, turn:b.example.org:3478", username: "u", credential: "c" },
  ]) expect(iceServerProblem(server), server.urls).toBeNull();

  expect(iceServerProblem({ urls: "turn:turn.example.org:3478" })).toContain("username and credential");
  expect(iceServerProblem({ urls: "turn:turn.example.org:3478", username: "u", credential: " " })).toContain("username and credential");
  for (const urls of ["turn.example.org:3478", "https://turn.example.org", "turn:", "turn:host/path", "javascript:alert(1)", "stun:host?x=1"])
    expect(iceServerProblem({ urls, username: "u", credential: "c" }), urls).toContain("not a TURN or STUN address");
  expect(iceServerProblem({ urls: "  " })).toContain("Enter the TURN server address");
});

it("quotes a refused address without its user, password, query or fragment", () => {
  for (const [urls, shown] of [
    ["turn:host?token=s3cr3t", "turn:host"],
    ["turns://user:s3cr3t@host:5349", "turns://host:5349"],
    ["https://user:s3cr3t@turn.example.org/#s3cr3t", "https://turn.example.org/"],
    ["https://turn.example.org", "https://turn.example.org"],
    // A ? or # before the last @: that @ may be in the password or in the query, so neither is said.
    ["turn:user:pa#s3cr3t@host", "turn:…"],
    ["turn:user:pa?s3cr3t@host", "turn:…"],
    ["turn:host?username=me@example.org&credential=s3cr3t", "turn:…"],
    ["turn:host#frag@s3cr3t", "turn:…"],
    ["turn:user:s3cr3t@host?x=a@b&token=s3cr3t", "turn:…"],
    ["s3cr3t:s3cr3t@host", "host"],
  ]) {
    const problem = iceServerProblem({ urls, username: "u", credential: "c" });
    expect(problem, urls).toBe(`“${shown}” is not a TURN or STUN address (turn:host:port)`);
    expect(problem, urls).not.toContain("s3cr3t");
  }
});
it("says only the scheme of a refused piece when a space or comma in a user or password split the address before its @", () => {
  for (const [urls, shown] of [
    ["turn:alice:hunter#2 s3cr3t@turn.example.org:3478", "turn:…"],
    ["turn://alice:hunter2,s3cr3t@turn.example.org:3478", "turn://…"],
    ["turns://alice:hunter2\ts3cr3t@turn.example.org:5349", "turns://…"],
    ["alice:hunter#2 s3cr3t@turn.example.org", "…"],
  ]) {
    const problem = iceServerProblem({ urls, username: "u", credential: "c" });
    expect(problem, urls).toBe(`“${shown}” is not a TURN or STUN address (turn:host:port)`);
    expect(problem, urls).not.toMatch(/alice|hunter/);
  }
});


it("takes a server in WebRTC's form (urls a list) as the addresses comma-separated, and says a server without urls needs them", () => {
  const listed = iceServerSetting({ urls: ["stun:a.example.org", "turn:b.example.org:3478"], username: "u", credential: "c" } as unknown as IceServerSetting);
  expect(listed).toEqual({ urls: "stun:a.example.org, turn:b.example.org:3478", username: "u", credential: "c" });
  expect(iceServerProblem(listed)).toBeNull();
  const plain = { urls: "stun:a.example.org" };
  expect(iceServerSetting(plain)).toBe(plain);
  // Was a TypeError: "server.urls.split is not a function", "Cannot read properties of undefined (reading 'split')".
  for (const server of [{}, { url: "stun:a.example.org" }, { urls: 5 }, { urls: ["stun:a.example.org", 5] }])
    expect(iceServerProblem(iceServerSetting(server as unknown as IceServerSetting)), JSON.stringify(server)).toBe("Each ICE server needs urls: one address, or several comma-separated (turn:host:port)");
});

it("says a username or credential that is not a text is one, instead of failing on it", () => {
  // Was a TypeError: "server.credential?.trim is not a function", as `ghostly settings set iceServers` printed it.
  for (const server of [{ username: "u", credential: 5 }, { username: 5, credential: "c" }, { username: ["u"], credential: "c" }, { username: "u", credential: { c: 1 } }])
    expect(iceServerProblem({ urls: "turn:turn.example.org:3478", ...server } as unknown as IceServerSetting), JSON.stringify(server)).toBe("A TURN server's username and credential are texts");
  expect(iceServerProblem({ urls: "stun:stun.example.org:3478", username: 5 } as unknown as IceServerSetting)).toBe("A TURN server's username and credential are texts");
});

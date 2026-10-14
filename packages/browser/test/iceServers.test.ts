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

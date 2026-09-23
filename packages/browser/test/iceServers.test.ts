import { expect, it } from "vitest";
import { iceServerProblem } from "../src/shared/ice";

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

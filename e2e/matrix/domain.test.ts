import { describe, expect, it } from "vitest";
import { startTestDomain } from "../support/domain";

describe("the test domain (support/domain.ts)", () => {
  it("starts while another one is up, so a port somebody else holds never fails a test", async () => {
    const first = await startTestDomain();
    try {
      const second = await startTestDomain();
      expect(second.domain).not.toBe(first.domain);
      await second.close();
    } finally {
      await first.close();
    }
  });
});

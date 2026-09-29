import {expect,it} from "vitest";
import {publicKeyLabel} from "../../../src/lib/publicKeyLabel";
// covers: chats.list.key-label
it("keeps short keys intact and preserves both ends of long public keys",()=>{
  expect(publicKeyLabel("")).toBe("");expect(publicKeyLabel("abc")).toBe("abc");
  expect(publicKeyLabel("123456789012345")).toBe("123456789012345");
  const key="abcdef0123456789uvwxyz";
  expect(publicKeyLabel(key)).toBe("abcdef...uvwxyz");expect(key).toBe("abcdef0123456789uvwxyz");
});

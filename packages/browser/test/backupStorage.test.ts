import { expect, it } from "vitest";
import { S3Store, signS3, validateS3Config } from "../src/backup/s3";
import { backupName, createdFromName } from "../src/backup/storage";
import { decode, encode } from "../src/backup/codec";
import { open, seal } from "../src/backup/envelope";
// covers: storage.s3, backup.envelope, backup.passphrase-rules, delivery.hold.protocol

it("signs S3 requests exactly as AWS documents (SigV4 GET object example)", async () => {
  const headers = await signS3(
    { method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), headers: { Range: "bytes=0-9" } },
    { region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    new Date("2013-05-24T00:00:00Z"),
  );
  expect(headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

it("names backups without anything personal, sortable by date", () => {
  const name = backupName("abcdefghijklmnop", new Date("2026-09-23T10:20:30.456Z"));
  expect(name).toMatch(/^abcdefghijklmnop\/backups\/20260923T102030Z-[a-z2-7]{8}\.ghostly-backup$/);
  expect(createdFromName(name)).toBe(Date.parse("2026-09-23T10:20:30Z"));
});

it("refuses S3 settings that would leak or cannot work", () => {
  const ok = { endpoint: "https://s3.example.com/", region: "", bucket: "my-backups", prefix: "ghostly", accessKeyId: "k", secretAccessKey: "s" };
  expect(validateS3Config(ok)).toMatchObject({ endpoint: "https://s3.example.com", region: "us-east-1", prefix: "ghostly/" });
  expect(() => validateS3Config({ ...ok, endpoint: "http://s3.example.com" })).toThrow("HTTPS");
  expect(() => validateS3Config({ ...ok, endpoint: "https://key:secret@s3.example.com" })).toThrow("credentials");
  expect(() => validateS3Config({ ...ok, bucket: "Bad_Bucket" })).toThrow("Bucket");
  expect(validateS3Config({ ...ok, endpoint: "http://127.0.0.1:9000" }).endpoint).toBe("http://127.0.0.1:9000");
});

it("data shaped like a tag comes back as it was, and a bad tag never stops a restore", async () => {
  // A contact controls some stored values (transport descriptors, memos): they must not become tags.
  const poison = { $ghostly: "bigint", value: "nope" }, nested = { $ghostly: "object", entries: [["a", 1]] };
  const value = { descriptors: { "iroh/1": poison }, nested, list: [poison], n: 5n };
  const back = decode(await encode(value)) as typeof value;
  expect(back).toEqual(value);
  expect(Object.getPrototypeOf(back.descriptors["iroh/1"])).toBe(Object.prototype);
  expect(decode('{"a":{"$ghostly":"bigint","value":"x"},"b":{"$ghostly":"bytes","value":"!!"}}')).toEqual({ a: { $ghostly: "bigint", value: "x" }, b: { $ghostly: "bytes", value: "!!" } });
  const proto = decode('{"$ghostly":"object","entries":[["__proto__",{"polluted":true}]]}') as Record<string, unknown>;
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(Object.keys(proto)).toEqual(["__proto__"]);
});

it("round-trips bytes, bigints and blobs, and an envelope only opens with its passphrase", async () => {
  const value = { n: 12345678901234567890n, bytes: new Uint8Array([0, 1, 254, 255]), file: new Blob(["hello"], { type: "text/plain" }), nested: [{ a: 1 }] };
  const back = decode(await encode(value)) as typeof value;
  expect(back.n).toBe(value.n);
  expect(back.bytes).toEqual(value.bytes);
  expect(await back.file.text()).toBe("hello");
  expect(back.file.type).toBe("text/plain");
  const sealed = await seal("a".repeat(100_000), "correct horse battery");
  expect(sealed.length, "compressed before encryption").toBeLessThan(10_000);
  expect(JSON.parse(sealed)).toMatchObject({ format: "ghostly-backup", version: 1, compression: "gzip" });
  expect(await open(sealed, "correct horse battery")).toBe("a".repeat(100_000));
  await expect(open(sealed, "wrong passphrase!")).rejects.toThrow("Wrong passphrase");
  const tampered = JSON.parse(sealed); tampered.ciphertext = tampered.ciphertext.slice(0, -4) + "AAAA";
  await expect(open(JSON.stringify(tampered), "correct horse battery")).rejects.toThrow("changed");
  await expect(seal("x", "short")).rejects.toThrow("12 characters");
  const relabeled = JSON.parse(sealed); relabeled.compression = "none";
  await expect(open(JSON.stringify(relabeled), "correct horse battery"), "the clear header is authenticated too").rejects.toThrow("changed");
});

it("lists, follows continuation and reports S3 errors in plain words", async () => {
  const pages = [
    `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken><Contents><Key>g/abcdefghijklmnop/backups/20260101T000000Z-aaaaaaaa.ghostly-backup</Key><Size>10</Size></Contents></ListBucketResult>`,
    `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>g/abcdefghijklmnop/backups/20260102T000000Z-bbbbbbbb.ghostly-backup</Key><Size>20</Size></Contents></ListBucketResult>`,
  ];
  const seen: string[] = [];
  const fetcher = (async (url: URL) => { seen.push(String(url)); return new Response(pages.shift()!); }) as unknown as typeof fetch;
  const store = new S3Store({ endpoint: "https://s3.example.com", region: "us-east-1", bucket: "bkt", prefix: "g", accessKeyId: "k", secretAccessKey: "s" }, fetcher);
  const listed = await store.list("abcdefghijklmnop");
  expect(listed.map((b) => b.name)).toEqual(["abcdefghijklmnop/backups/20260101T000000Z-aaaaaaaa.ghostly-backup", "abcdefghijklmnop/backups/20260102T000000Z-bbbbbbbb.ghostly-backup"]);
  expect(seen[1]).toContain("continuation-token=t1");
  const refusing = new S3Store({ endpoint: "https://s3.example.com", region: "us-east-1", bucket: "bkt", prefix: "", accessKeyId: "k", secretAccessKey: "s" },
    (async () => new Response("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>", { status: 403 })) as unknown as typeof fetch);
  await expect(refusing.get("abcdefghijklmnop/backups/x.ghostly-backup")).rejects.toThrow("S3 refused (403 AccessDenied): Access Denied");
});

it("never leaves its own folder in the bucket, whatever a name or a listing says", async () => {
  const seen: string[] = [];
  const fetcher = (async (url: URL) => { seen.push(String(url)); return new Response(
    `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>again</NextContinuationToken>
      <Contents><Key>g/abcdefghijklmnop/backups/20260101T000000Z-aaaaaaaa.ghostly-backup</Key></Contents>
      <Contents><Key>g/abcdefghijklmnop/backups/../../../other/secret</Key></Contents>
      <Contents><Key>elsewhere/abcdefghijklmnop/backups/20260101T000000Z-bbbbbbbb.ghostly-backup</Key></Contents>
    </ListBucketResult>`); }) as unknown as typeof fetch;
  const store = new S3Store({ endpoint: "https://s3.example.com", region: "us-east-1", bucket: "bkt", prefix: "g", accessKeyId: "k", secretAccessKey: "s" }, fetcher);
  for (const name of ["../other-bucket/x", "abcdefghijklmnop/backups/../../x", "abcdefghijklmnop/other/x", "/abs", ""]) {
    await expect(store.get(name), name).rejects.toThrow("Not a Ghostly backup name");
    await expect(store.put(name, new Uint8Array()), name).rejects.toThrow("Not a Ghostly backup name");
  }
  await expect(store.list("../x")).rejects.toThrow("Not a Ghostly backup name");
  expect(seen).toEqual([]);
  // A listing that never ends, with keys from elsewhere: bounded, and only this folder's names.
  const listed = await store.list("abcdefghijklmnop");
  expect(new Set(listed.map((b) => b.name))).toEqual(new Set(["abcdefghijklmnop/backups/20260101T000000Z-aaaaaaaa.ghostly-backup"]));
  expect(seen.length).toBe(100);
  expect(() => validateS3Config({ endpoint: "https://s3.example.com", region: "", bucket: "bkt", prefix: "a/../b", accessKeyId: "k", secretAccessKey: "s" })).toThrow("prefix");
  const huge = new S3Store({ endpoint: "https://s3.example.com", region: "", bucket: "bkt", prefix: "", accessKeyId: "k", secretAccessKey: "s" },
    (async () => new Response("x", { headers: { "content-length": String(2 * 1024 ** 3) } })) as unknown as typeof fetch);
  await expect(huge.get("abcdefghijklmnop/backups/x.ghostly-backup")).rejects.toThrow("too large");
});

it("presigns a read exactly as AWS documents (SigV4 query-string GET object example), and keeps held items in their folder", async () => {
  const { presignS3, S3Store } = await import("../src/backup/s3");
  const { heldName, manifestName } = await import("../src/backup/storage");
  const url = await presignS3(
    { method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), expiresSeconds: 86400 },
    { region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    new Date("2013-05-24T00:00:00Z"),
  );
  expect(new URL(url).searchParams.get("X-Amz-Signature")).toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  expect(url).not.toContain("wJalrXUtnFEMI");
  const mailbox = "abcdefghijklmnopqrstuv";
  expect(heldName("abcdefghijklmnop", mailbox, 12)).toMatch(/^abcdefghijklmnop\/hold\/abcdefghijklmnopqrstuv\/00000012-[a-z2-7]{8}\.ghostly-held$/);
  const seen: { method: string; url: string; type?: string }[] = [];
  const fetcher = (async (input: URL, init: RequestInit) => { seen.push({ method: init.method!, url: String(input), type: (init.headers as Record<string, string>)["content-type"] }); return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"); }) as unknown as typeof fetch;
  const store = new S3Store({ endpoint: "https://s3.example.com", region: "us-east-1", bucket: "bkt", prefix: "g", accessKeyId: "k", secretAccessKey: "s" }, fetcher);
  await store.put(manifestName("abcdefghijklmnop", mailbox), new Uint8Array([1]));
  expect(seen[0]).toMatchObject({ method: "PUT", url: "https://s3.example.com/bkt/g/abcdefghijklmnop/hold/abcdefghijklmnopqrstuv/manifest.ghostly-held", type: "application/vnd.ghostly.held" });
  await store.listFolder("abcdefghijklmnop", mailbox);
  expect(seen[1].url).toContain("prefix=g%2Fabcdefghijklmnop%2Fhold%2Fabcdefghijklmnopqrstuv%2F");
  await expect(store.put("abcdefghijklmnop/hold/short/x.ghostly-held", new Uint8Array())).rejects.toThrow("Not a Ghostly backup name");
  await expect(store.listFolder("abcdefghijklmnop", "../backups")).rejects.toThrow("Not a Ghostly backup name");
  const presigned = await store.presign(heldName("abcdefghijklmnop", mailbox, 1), 10 * 24 * 3600);
  expect(new URL(presigned).searchParams.get("X-Amz-Expires")).toBe(String(7 * 24 * 3600));
  expect(seen).toHaveLength(2);
});

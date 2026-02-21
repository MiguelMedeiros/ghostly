import { invoke } from "@tauri-apps/api/core";

export async function generateEncryptionKey(): Promise<string> {
  return invoke<string>("generate_enc_key");
}

export async function encrypt(
  plaintext: string,
  keyB64: string,
): Promise<string> {
  return invoke<string>("encrypt_text", { plaintext, keyB64 });
}

export async function decrypt(
  encoded: string,
  keyB64: string,
): Promise<string> {
  return invoke<string>("decrypt_text", { encoded, keyB64 });
}

export async function toBase64Url(bytes: Uint8Array): Promise<string> {
  const binary = String.fromCharCode(...bytes);
  const std = btoa(binary);
  return std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(str: string): Uint8Array {
  let b = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  const binary = atob(b);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

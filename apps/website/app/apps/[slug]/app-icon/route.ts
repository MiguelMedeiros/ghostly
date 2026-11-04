import { ICON_EDGES } from "@/lib/appIcon";
import { appsReleased } from "@/lib/appsGate";
import { storeApp } from "@/lib/store";

// An app's icon.png, from the bundle the build read and checked (a square PNG of at most 1024 px, lib/storeRead.ts):
// served by this site, so a reader's browser never asks GitHub or jsDelivr for it. `?s=` asks for it at one of the edges
// the pages draw it at (lib/appIcon.ts), as WebP: a 1024 px icon of 228 KB is about 1 KB at a card's 112 px. An icon no
// larger than that edge, or one the resize fails on, is served as the bundle holds it.
export const revalidate = 0;

/** By digest and edge: at most 200 apps (STORE_LIMITS.apps) times the six edges, each a few KB. */
const resized = new Map<string, Promise<{ bytes: Uint8Array; type: string }>>();

const pngEdge = (png: Uint8Array) => new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(16);

async function iconAt(png: Uint8Array, edge: number): Promise<{ bytes: Uint8Array; type: string }> {
  const original = { bytes: png, type: "image/png" };
  if (pngEdge(png) <= edge) return original;
  try {
    const { default: sharp } = await import("sharp");
    const bytes = await sharp(png, { limitInputPixels: 1024 * 1024 }).resize(edge, edge).webp({ quality: 90 }).toBuffer();
    return { bytes: new Uint8Array(bytes), type: "image/webp" };
  } catch {
    return original;
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const app = (await appsReleased()) ? storeApp((await params).slug) : undefined;
  const asked = new URL(request.url).searchParams.get("s");
  const edge = asked === null ? undefined : ICON_EDGES.find((e) => String(e) === asked);
  if (!app?.icon || (asked !== null && edge === undefined)) return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain" } });
  let icon = { bytes: app.icon, type: "image/png" };
  if (edge !== undefined) {
    const key = `${app.digest}:${edge}`;
    if (!resized.has(key)) resized.set(key, iconAt(app.icon, edge));
    icon = await resized.get(key)!;
  }
  return new Response(icon.bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": icon.type,
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

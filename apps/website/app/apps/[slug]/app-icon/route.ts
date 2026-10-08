import { appsReleased } from "@/lib/appsGate";
import { storeApp } from "@/lib/store";

// An app's icon.png, from the bundle the build read and checked (a square PNG, lib/storeRead.ts): served by this site, so
// a reader's browser never asks GitHub or jsDelivr for it.
export const revalidate = 0;

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const app = (await appsReleased()) ? storeApp((await params).slug) : undefined;
  if (!app?.icon) return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain" } });
  return new Response(app.icon as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

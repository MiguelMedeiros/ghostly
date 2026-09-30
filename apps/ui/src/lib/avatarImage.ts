import { MAX_AVATAR_LENGTH, sanitizeAvatar } from "@ghostly/core";

/** The side of the square picture Ghostly keeps and sends. */
export const AVATAR_SIDE = 128;

/**
 * A picture file made into what Ghostly sends: its centre cropped square and redrawn at 128×128 as a
 * fresh JPEG. Redrawing keeps the pixels only, so nothing of the original file travels (no location,
 * camera or edit history), and the result is a few kilobytes. `maxLength` bounds the data URL
 * (a group's picture has less room than a profile picture: `MAX_GROUP_PICTURE_LENGTH`).
 */
export async function avatarFromFile(file: File, maxLength = MAX_AVATAR_LENGTH): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose a picture");
  if (file.size > 20 * 1024 * 1024) throw new Error("That picture is too large (max 20 MB)");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("This picture cannot be read here. Try a JPEG or PNG."); }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = AVATAR_SIDE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This picture cannot be read here");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
    for (const quality of [0.86, 0.75, 0.6, 0.45]) {
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length <= maxLength && typeof sanitizeAvatar(url) === "string") return url;
    }
    throw new Error("This picture could not be made small enough");
  } finally {
    bitmap.close();
  }
}

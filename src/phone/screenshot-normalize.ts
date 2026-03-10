import { getImageMetadata, resizeToJpeg } from "../media/image-ops.js";

export const DEFAULT_PHONE_SCREENSHOT_MAX_SIDE = 1260;
export const DEFAULT_PHONE_SCREENSHOT_MAX_BYTES = 1_500_000;

export async function normalizePhoneScreenshot(
  buffer: Buffer,
  opts?: {
    maxSide?: number;
    maxBytes?: number;
  },
): Promise<{ buffer: Buffer; contentType?: "image/jpeg" }> {
  const maxSide = Math.max(1, Math.round(opts?.maxSide ?? DEFAULT_PHONE_SCREENSHOT_MAX_SIDE));
  const maxBytes = Math.max(1, Math.round(opts?.maxBytes ?? DEFAULT_PHONE_SCREENSHOT_MAX_BYTES));

  const meta = await getImageMetadata(buffer);
  const width = Number(meta?.width ?? 0);
  const height = Number(meta?.height ?? 0);
  const maxDim = Math.max(width, height);

  if (buffer.byteLength <= maxBytes && (maxDim === 0 || (width <= maxSide && height <= maxSide))) {
    return { buffer };
  }

  const qualities = [82, 72, 62, 52, 42];
  const sideStart = maxDim > 0 ? Math.min(maxSide, maxDim) : maxSide;
  const sideGrid = [sideStart, 1260, 1120, 960, 840, 720]
    .map((value) => Math.min(maxSide, value))
    .filter((value, index, list) => value > 0 && list.indexOf(value) === index)
    .sort((left, right) => right - left);

  let smallest: { buffer: Buffer; size: number } | null = null;

  for (const side of sideGrid) {
    for (const quality of qualities) {
      const out = await resizeToJpeg({
        buffer,
        maxSide: side,
        quality,
        withoutEnlargement: true,
      });

      if (!smallest || out.byteLength < smallest.size) {
        smallest = { buffer: out, size: out.byteLength };
      }

      if (out.byteLength <= maxBytes) {
        return { buffer: out, contentType: "image/jpeg" };
      }
    }
  }

  const best = smallest?.buffer ?? buffer;
  return { buffer: best, contentType: best === buffer ? undefined : "image/jpeg" };
}

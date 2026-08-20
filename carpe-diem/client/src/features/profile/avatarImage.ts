import { AVATAR_SIZE, MAX_AVATAR_LENGTH } from '@shared/protocol';

export type AvatarError = 'not-an-image' | 'too-large' | 'decode-failed';

const MAX_SOURCE_BYTES = 12 * 1024 * 1024;

/**
 * Turns a picked file into a small square JPEG data URL.
 *
 * The downscale happens here rather than on the server because the picture
 * has to be small before it goes anywhere: it rides inside the room snapshot
 * to every participant, so a 4MB phone photo would be 4MB in six browsers.
 * A 96px square JPEG lands at a few kilobytes.
 */
export async function fileToAvatarDataUrl(
  file: File,
): Promise<{ ok: true; dataUrl: string } | { ok: false; error: AvatarError }> {
  if (!file.type.startsWith('image/')) return { ok: false, error: 'not-an-image' };
  if (file.size > MAX_SOURCE_BYTES) return { ok: false, error: 'too-large' };

  let bitmap: ImageBitmap | HTMLImageElement;
  try {
    bitmap = await decode(file);
  } catch {
    return { ok: false, error: 'decode-failed' };
  }

  const width = 'width' in bitmap ? bitmap.width : 0;
  const height = 'height' in bitmap ? bitmap.height : 0;
  if (!width || !height) return { ok: false, error: 'decode-failed' };

  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const context = canvas.getContext('2d');
  if (!context) return { ok: false, error: 'decode-failed' };

  // Centre-crop to a square so portraits and landscapes both frame sensibly
  // instead of being squashed.
  const side = Math.min(width, height);
  const sourceX = (width - side) / 2;
  const sourceY = (height - side) / 2;

  context.imageSmoothingQuality = 'high';
  context.drawImage(
    bitmap as CanvasImageSource,
    sourceX,
    sourceY,
    side,
    side,
    0,
    0,
    AVATAR_SIZE,
    AVATAR_SIZE,
  );

  if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close();

  // Step the quality down until it fits. In practice the first attempt is
  // already a few KB; the loop is insurance against pathological inputs.
  for (const quality of [0.82, 0.7, 0.55, 0.4]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrl.length <= MAX_AVATAR_LENGTH) return { ok: true, dataUrl };
  }

  return { ok: false, error: 'too-large' };
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  // createImageBitmap applies EXIF orientation, which is what stops photos
  // taken in portrait from arriving sideways.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Older Safari rejects the options bag; fall through to the img path.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('decode failed'));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

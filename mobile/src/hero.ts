// The picture across the top of a new chat. Chosen from this phone's photos
// in Settings and kept on the phone only — shrunk first, so it fits the
// browser's storage and loads at once.

import { create } from "zustand";

const HERO_KEY = "egant.phone.hero";

function read(): string | null {
  try {
    return localStorage.getItem(HERO_KEY);
  } catch {
    return null;
  }
}

export const useHero = create<{ image: string | null }>()(() => ({ image: read() }));

/** Wide enough for the strip at 3x on a large phone; each step down is a
 * fallback for storage that turns out to be smaller than hoped. */
const ATTEMPTS = [
  { side: 1400, quality: 0.84 },
  { side: 1000, quality: 0.78 },
  { side: 720, quality: 0.72 },
];

async function decode(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Shrinks the photo and keeps it. Throws with a sentence fit for a toast. */
export async function setHero(file: File): Promise<void> {
  if (!file.type.startsWith("image/")) throw new Error("That file is not a picture.");
  let image: HTMLImageElement;
  try {
    image = await decode(file);
  } catch {
    throw new Error("This picture could not be opened.");
  }
  for (const { side, quality } of ATTEMPTS) {
    const scale = Math.min(1, side / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) break;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", quality);
    try {
      localStorage.setItem(HERO_KEY, data);
      useHero.setState({ image: data });
      return;
    } catch {
      // Too big for the storage left: try smaller.
    }
  }
  throw new Error("This phone has no room to keep that picture.");
}

export function clearHero(): void {
  try {
    localStorage.removeItem(HERO_KEY);
  } catch {
    // Nothing kept, nothing to remove.
  }
  useHero.setState({ image: null });
}

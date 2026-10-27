import { create } from "zustand";
import { api } from "./api";
import { useEgant } from "../store";
import { basename } from "./transcript";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "bmp",
  "avif",
  "icns",
]);

/** Lowercase extension without the leading dot. */
export function extensionOf(pathOrName: string): string {
  const clean = pathOrName.split("?")[0]!.split("#")[0]!;
  const dot = clean.lastIndexOf(".");
  return dot < 0 ? "" : clean.slice(dot + 1).toLowerCase();
}

/** Whether the given filename or path is an image. */
export function isImage(pathOrName?: string | null): boolean {
  if (!pathOrName) return false;
  return IMAGE_EXTENSIONS.has(extensionOf(pathOrName));
}

/** Whether a string is a base64 or raw image data URL. */
export function isDataUrlImage(text?: string | null): boolean {
  if (!text) return false;
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(text.trim());
}

/** Extracts an embedded image data URL if present, along with any remaining text. */
export function extractDataUrl(
  text: string,
): { dataUrl: string; remainingText: string } | null {
  if (!text) return null;
  const match = /(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)/.exec(text);
  if (!match) return null;
  const dataUrl = match[1]!;
  const remainingText = text.replace(dataUrl, "").trim();
  return { dataUrl, remainingText };
}

/** Regular expression for matching image file paths in text (e.g. tool output or bash commands). */
const IMAGE_PATH_REGEX =
  /(?:^|[\s"'`([<{])([a-zA-Z0-9_.~/\\-]+\.(?:png|jpe?g|webp|gif|svg|bmp|avif|icns))(?=$|[\s"'`)\]>}])/gi;

/** Finds candidate image file paths mentioned inside text. */
export function extractImagePaths(text: string): string[] {
  if (!text) return [];
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  IMAGE_PATH_REGEX.lastIndex = 0;
  while ((m = IMAGE_PATH_REGEX.exec(text)) !== null) {
    const raw = m[1]?.trim();
    if (raw && !raw.startsWith("data:") && !raw.startsWith("http:") && !raw.startsWith("https:")) {
      paths.push(raw);
    }
  }
  return Array.from(new Set(paths));
}

/** Resolves any image source (data URL, web URL, absolute path, file:// URL,
 * or relative project path) to a renderable data URL or web URL. */
export async function resolveImageDataUrl(
  src: string,
  workspaceRoot?: string,
): Promise<string | null> {
  const trimmed = src.trim();
  if (!trimmed) return null;

  // Already a web or data URI
  if (
    trimmed.startsWith("data:image/") ||
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://")
  ) {
    return trimmed;
  }

  // File path (relative or absolute, or file:// URL)
  let clean = trimmed.replace(/^file:\/\//, "");
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // Keep clean as-is if URI decoding fails
  }

  try {
    const result = await api.blobDataUrl(workspaceRoot || "", clean, "workdir");
    return result;
  } catch (err) {
    console.warn(`Failed to resolve image data URL for "${clean}":`, err);
    return null;
  }
}

/** Copies an image (either data URL or local/remote source) to the system clipboard as a PNG image. */
export async function copyImageToClipboard(srcOrDataUrl: string): Promise<boolean> {
  try {
    const res = await fetch(srcOrDataUrl);
    const blob = await res.blob();
    if (blob.type === "image/png") {
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
      return true;
    }

    // Convert non-PNG images to PNG for full clipboard compatibility
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = srcOrDataUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0);

    const pngBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!pngBlob) return false;

    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": pngBlob }),
    ]);
    return true;
  } catch (err) {
    console.error("Failed to copy image to clipboard:", err);
    try {
      await navigator.clipboard.writeText(srcOrDataUrl);
      return true;
    } catch {
      return false;
    }
  }
}

/** Triggers a browser download of an image. */
export function downloadImage(url: string, filename = "screenshot.png") {
  const cleanName = filename.split("/").pop() || "screenshot.png";
  const a = document.createElement("a");
  a.href = url;
  a.download = cleanName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ---------------------------------------------------------------------------
// Lightbox state store
// ---------------------------------------------------------------------------

export interface LightboxImage {
  src: string;
  alt?: string;
  title?: string;
  filePath?: string;
  dimensions?: { width: number; height: number };
}

interface ImageLightboxStore {
  activeImage: LightboxImage | null;
  open: (img: LightboxImage) => void;
  close: () => void;
}

export const useImageLightbox = create<ImageLightboxStore>((set) => ({
  activeImage: null,
  open: (img) => set({ activeImage: img }),
  close: () => set({ activeImage: null }),
}));

/** Opens a file in a stage tab for the currently active session. */
export function openImageInEditor(path: string, name?: string) {
  const store = useEgant.getState();
  const sessionId = store.snapshot?.activeSession;
  if (sessionId != null) {
    store.openFile(sessionId, path, name || basename(path) || "image");
  }
}

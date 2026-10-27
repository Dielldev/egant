import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Image as ImageIcon,
  ImageOff,
  Maximize2,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import {
  copyImageToClipboard,
  downloadImage,
  openImageInEditor,
  resolveImageDataUrl,
  useImageLightbox,
} from "../lib/images";
import { basename } from "../lib/transcript";
import { useEgant, workspaceRoot } from "../store";

interface ChatImageProps {
  src?: string;
  alt?: string;
  title?: string;
}

export const ChatImage = memo(function ChatImage({
  src,
  alt,
  title,
}: ChatImageProps) {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);

  const root = useEgant((s) => workspaceRoot(s.snapshot));
  const openLightbox = useImageLightbox((s) => s.open);

  useEffect(() => {
    if (!src) {
      setLoading(false);
      setError(true);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(false);

    resolveImageDataUrl(src, root)
      .then((dataUrl) => {
        if (cancelled) return;
        if (dataUrl) {
          setResolvedUrl(dataUrl);
          setError(false);
        } else {
          setError(true);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [src, root]);

  const fileName = src
    ? (basename(src.replace(/^file:\/\//, "")) || src)
    : "";

  const isLocalFile =
    src &&
    !src.startsWith("data:") &&
    !src.startsWith("blob:") &&
    !src.startsWith("http://") &&
    !src.startsWith("https://");

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!resolvedUrl) return;
    const ok = await copyImageToClipboard(resolvedUrl);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!resolvedUrl) return;
    downloadImage(resolvedUrl, fileName || "screenshot.png");
  };

  const handleOpenInTab = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!src || !isLocalFile) return;
    const cleanPath = src.replace(/^file:\/\//, "");
    openImageInEditor(cleanPath, fileName || "image");
  };

  const handleClickImage = () => {
    if (!resolvedUrl) return;
    openLightbox({
      src: resolvedUrl,
      alt,
      title: title || fileName || alt,
      filePath: isLocalFile ? src.replace(/^file:\/\//, "") : undefined,
      dimensions: dimensions ?? undefined,
    });
  };

  // Loading skeleton
  if (loading) {
    return (
      <span className="my-2.5 flex h-48 w-full max-w-[540px] items-center justify-center rounded-xl border border-[var(--border)] bg-[rgba(0,0,0,0.08)] animate-pulse">
        <span className="flex flex-col items-center gap-2 text-[var(--faint)]">
          <ImageIcon size={22} className="opacity-50" />
          <span className="text-xs">Loading screenshot…</span>
        </span>
      </span>
    );
  }

  // Error fallback
  if (error || !resolvedUrl) {
    return (
      <span className="my-2.5 flex max-w-[540px] items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[rgba(0,0,0,0.08)] px-3.5 py-2.5 text-xs text-[var(--muted)]">
        <ImageOff size={16} className="shrink-0 text-[var(--faint)]" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {alt || fileName || "Image could not be loaded"}
        </span>
        {isLocalFile && (
          <button
            type="button"
            onClick={handleOpenInTab}
            className="flex cursor-pointer items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
          >
            <span>Open tab</span>
            <ExternalLink size={11} />
          </button>
        )}
      </span>
    );
  }

  return (
    <span className="group relative my-3 flex flex-col max-w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-sm">
      {/* Image Container with checkered transparency pattern */}
      <span
        className="image-checker relative flex cursor-pointer items-center justify-center overflow-hidden p-2"
        onClick={handleClickImage}
      >
        <img
          src={resolvedUrl}
          alt={alt || "Screenshot"}
          title={title || alt || "Click to view full size"}
          onLoad={(e) => {
            const img = e.currentTarget;
            setDimensions({
              width: img.naturalWidth,
              height: img.naturalHeight,
            });
          }}
          className="max-h-[460px] w-auto max-w-full rounded-lg object-contain transition-transform duration-150 group-hover:scale-[1.008]"
        />

        {/* Hover Action Buttons */}
        <span className="absolute top-3.5 right-3.5 flex items-center gap-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <button
            type="button"
            title="View full size"
            onClick={handleClickImage}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-black/60 text-white shadow backdrop-blur-sm hover:bg-black/80"
          >
            <Maximize2 size={13} strokeWidth={2} />
          </button>

          <button
            type="button"
            title="Copy image"
            onClick={handleCopy}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-black/60 text-white shadow backdrop-blur-sm hover:bg-black/80"
          >
            {copied ? (
              <Check size={13} className="text-emerald-400" strokeWidth={2.5} />
            ) : (
              <Copy size={13} strokeWidth={2} />
            )}
          </button>

          <button
            type="button"
            title="Download image"
            onClick={handleDownload}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-black/60 text-white shadow backdrop-blur-sm hover:bg-black/80"
          >
            <Download size={13} />
          </button>

          {isLocalFile && (
            <button
              type="button"
              title="Open in file tab"
              onClick={handleOpenInTab}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-black/60 text-white shadow backdrop-blur-sm hover:bg-black/80"
            >
              <ExternalLink size={13} strokeWidth={2} />
            </button>
          )}
        </span>
      </span>

      {/* Caption footer */}
      {(alt || title || dimensions) && (
        <span className="flex items-center justify-between border-t border-[var(--border)] bg-[rgba(0,0,0,0.08)] px-3 py-1.5 text-xs text-[var(--faint)]">
          <span className="truncate" title={alt || title}>
            {alt || title || fileName}
          </span>
          {dimensions && (
            <span className="shrink-0 font-mono text-[10px] opacity-75">
              {dimensions.width} × {dimensions.height}
            </span>
          )}
        </span>
      )}
    </span>
  );
});

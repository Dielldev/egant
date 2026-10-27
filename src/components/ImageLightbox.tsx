import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Minus,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  copyImageToClipboard,
  downloadImage,
  openImageInEditor,
  useImageLightbox,
} from "../lib/images";
import { basename } from "../lib/transcript";

export function ImageLightbox() {
  const activeImage = useImageLightbox((s) => s.activeImage);
  const close = useImageLightbox((s) => s.close);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [copied, setCopied] = useState(false);
  const [imgNaturalSize, setImgNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  // Reset viewport whenever a new image opens
  useEffect(() => {
    if (activeImage) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setCopied(false);
      setImgNaturalSize(activeImage.dimensions ?? null);
    }
  }, [activeImage]);

  // Keyboard shortcut listener
  useEffect(() => {
    if (!activeImage) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
      } else if (e.key === "+" || e.key === "=") {
        setZoom((z) => Math.min(5, Math.round((z + 0.25) * 100) / 100));
      } else if (e.key === "-" || e.key === "_") {
        setZoom((z) => Math.max(0.2, Math.round((z - 0.25) * 100) / 100));
      } else if (e.key === "0") {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeImage, close]);

  const handleCopy = useCallback(async () => {
    if (!activeImage) return;
    const ok = await copyImageToClipboard(activeImage.src);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }, [activeImage]);

  const handleDownload = useCallback(() => {
    if (!activeImage) return;
    const filename =
      activeImage.filePath?.split("/").pop() ||
      activeImage.title ||
      activeImage.alt ||
      "screenshot.png";
    downloadImage(activeImage.src, filename);
  }, [activeImage]);

  const handleOpenInTab = useCallback(() => {
    if (!activeImage?.filePath) return;
    openImageInEditor(activeImage.filePath, basename(activeImage.filePath) || "screenshot");
    close();
  }, [activeImage, close]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const factor = e.deltaY < 0 ? 1.15 : 0.85;
    setZoom((z) => {
      const next = Math.max(0.2, Math.min(6, Math.round(z * factor * 100) / 100));
      return next;
    });
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      setIsDragging(true);
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    },
    [pan],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return;
      setPan({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    },
    [isDragging, dragStart],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDoubleClick = useCallback(() => {
    if (zoom !== 1) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    } else {
      setZoom(2);
    }
  }, [zoom]);

  if (!activeImage) return null;

  const displayTitle =
    activeImage.title ||
    activeImage.alt ||
    (activeImage.filePath ? basename(activeImage.filePath) : null) ||
    "Screenshot";

  const sizeText = imgNaturalSize
    ? `${imgNaturalSize.width} × ${imgNaturalSize.height} px`
    : null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-md select-none animate-in fade-in duration-150"
      onMouseDown={close}
    >
      {/* Top Header Bar */}
      <div
        className="relative z-10 flex h-14 shrink-0 items-center justify-between border-b border-white/10 bg-black/50 px-5 text-white backdrop-blur-sm"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Title and dimension badge */}
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-sm font-medium tracking-wide">
            {displayTitle}
          </span>
          {sizeText && (
            <span className="rounded-md bg-white/10 px-2 py-0.5 font-mono text-[11px] text-white/70">
              {sizeText}
            </span>
          )}
        </div>

        {/* Toolbar Controls */}
        <div className="flex items-center gap-2">
          {/* Zoom controls */}
          <div className="flex items-center rounded-lg border border-white/10 bg-white/5 p-0.5">
            <button
              type="button"
              title="Zoom out (-)"
              onClick={() => setZoom((z) => Math.max(0.2, Math.round((z - 0.25) * 100) / 100))}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white"
            >
              <Minus size={13} strokeWidth={2.5} />
            </button>
            <span className="w-12 text-center font-mono text-xs text-white/80">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              title="Zoom in (+)"
              onClick={() => setZoom((z) => Math.min(5, Math.round((z + 0.25) * 100) / 100))}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white"
            >
              <Plus size={13} strokeWidth={2.5} />
            </button>
            <button
              type="button"
              title="Reset Zoom (0)"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white"
            >
              <RotateCcw size={12} strokeWidth={2} />
            </button>
          </div>

          <div className="mx-1 h-5 w-px bg-white/10" />

          {/* Open in File Tab (if on disk) */}
          {activeImage.filePath && (
            <button
              type="button"
              title="Open in file viewer"
              onClick={handleOpenInTab}
              className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 text-xs text-white/80 hover:bg-white/10 hover:text-white"
            >
              <ExternalLink size={13} />
              <span>Open in tab</span>
            </button>
          )}

          {/* Copy Image */}
          <button
            type="button"
            title="Copy image to clipboard"
            onClick={handleCopy}
            className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 text-xs text-white/80 hover:bg-white/10 hover:text-white"
          >
            {copied ? (
              <>
                <Check size={13} className="text-emerald-400" />
                <span className="text-emerald-400">Copied</span>
              </>
            ) : (
              <>
                <Copy size={13} />
                <span>Copy</span>
              </>
            )}
          </button>

          {/* Download */}
          <button
            type="button"
            title="Download image"
            onClick={handleDownload}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/80 hover:bg-white/10 hover:text-white"
          >
            <Download size={14} />
          </button>

          {/* Close */}
          <button
            type="button"
            title="Close (Esc)"
            onClick={close}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-white/10 bg-white/10 text-white hover:bg-white/20"
          >
            <X size={15} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      {/* Main Viewport */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        <div
          className="relative inline-block max-h-full max-w-full transition-transform duration-75"
          style={{
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
            cursor: zoom > 1 ? (isDragging ? "grabbing" : "grab") : "default",
          }}
          onDoubleClick={handleDoubleClick}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="image-checker overflow-hidden rounded-lg shadow-2xl ring-1 ring-white/10">
            <img
              src={activeImage.src}
              alt={displayTitle}
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                setImgNaturalSize({
                  width: img.naturalWidth,
                  height: img.naturalHeight,
                });
              }}
              className="max-h-[82vh] max-w-[88vw] object-contain"
            />
          </div>
        </div>

        {/* Bottom hint */}
        <div
          className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3.5 py-1 text-[11px] text-white/50 backdrop-blur-sm"
          onMouseDown={(e) => e.stopPropagation()}
        >
          Scroll to zoom · Drag to pan · Double-click to toggle fit · Esc to close
        </div>
      </div>
    </div>,
    document.body,
  );
}

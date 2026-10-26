import { Check, Copy, ExternalLink, Globe } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { isMac } from "../lib/platform";
import { hostnameOf, useEgant } from "../store";

/** Ensures a web address has an explicit protocol so neither the in-app
 * webview nor the platform's URL opener rejects it. */
export function resolveLinkUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }
  if (trimmed.startsWith("localhost") || trimmed.startsWith("127.0.0.1")) {
    return `http://${trimmed}`;
  }
  if (!trimmed.includes(" ") && trimmed.includes(".")) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

interface ChatLinkProps {
  href?: string;
  children?: React.ReactNode;
  className?: string;
}

/** Interactive link component for chat transcripts and markdown.
 * - Primary click: opens in Egant's built-in browser tab in the side panel.
 * - ⌘-click (Mac) / Ctrl-click / Middle-click or hover button: opens in external default browser.
 * - Right-click: shows a context menu with options to open in app, open in default browser, or copy link.
 */
export function ChatLink({ href, children, className }: ChatLinkProps) {
  const openBrowserTab = useEgant((s) => s.openBrowserTab);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const resolved = href ? resolveLinkUrl(href) : "";
  const isWebUrl = resolved.startsWith("http://") || resolved.startsWith("https://");

  const openInApp = useCallback(() => {
    if (!resolved) return;
    openBrowserTab(resolved);
  }, [openBrowserTab, resolved]);

  const openExternal = useCallback(() => {
    if (!resolved) return;
    void api.openUrl(resolved).catch((err: unknown) => {
      console.error("Failed to open external url:", err);
    });
  }, [resolved]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!isWebUrl) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) {
        openExternal();
      } else {
        openInApp();
      }
    },
    [isWebUrl, openExternal, openInApp],
  );

  const handleAuxClick = useCallback(
    (e: React.MouseEvent) => {
      if (!isWebUrl || e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      openExternal();
    },
    [isWebUrl, openExternal],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!isWebUrl) return;
      e.preventDefault();
      e.stopPropagation();
      setMenuPos({ x: e.clientX, y: e.clientY });
    },
    [isWebUrl],
  );

  useEffect(() => {
    if (!menuPos) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuPos(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuPos]);

  if (!href) {
    return <span className={className}>{children}</span>;
  }

  // Non-web links (anchors, etc.) retain standard behavior
  if (!isWebUrl) {
    return (
      <a
        href={href}
        className={className || "text-[var(--accent)] underline underline-offset-2 hover:opacity-80"}
      >
        {children}
      </a>
    );
  }

  const shortcutHint = isMac() ? "⌘-click" : "Ctrl-click";
  const tooltip = `${resolved}\nClick to open in app browser · ${shortcutHint} for system browser`;

  const MENU_WIDTH = 210;
  const MENU_HEIGHT = 115;
  const left = menuPos
    ? Math.max(8, Math.min(menuPos.x, window.innerWidth - MENU_WIDTH - 8))
    : 0;
  const top = menuPos
    ? Math.max(8, Math.min(menuPos.y, window.innerHeight - MENU_HEIGHT - 8))
    : 0;

  return (
    <span className="group/link inline relative">
      <a
        href={resolved}
        onClick={handleClick}
        onAuxClick={handleAuxClick}
        onContextMenu={handleContextMenu}
        title={tooltip}
        className={
          className ||
          "cursor-pointer text-[var(--accent)] underline underline-offset-2 hover:opacity-80"
        }
      >
        {children}
      </a>
      <button
        type="button"
        title="Open in system browser"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openExternal();
        }}
        className="inline-flex items-center align-middle ml-0.5 p-0.5 rounded opacity-0 group-hover/link:opacity-70 hover:!opacity-100 text-[var(--faint)] hover:text-[var(--ink)] cursor-pointer transition-opacity"
      >
        <ExternalLink size={11} strokeWidth={2.2} />
      </button>

      {menuPos &&
        createPortal(
          <div
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <div
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setMenuPos(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuPos(null);
              }}
            />
            <div
              style={{ left, top, width: MENU_WIDTH }}
              className="menu menu-pop fixed z-50 flex flex-col overflow-hidden rounded-xl p-1 text-[12.5px]"
            >
              <div className="px-2 py-1 text-[11px] font-medium text-[var(--faint)] truncate border-b border-[var(--border)] mb-1">
                {hostnameOf(resolved)}
              </div>
              <button
                type="button"
                onClick={() => {
                  setMenuPos(null);
                  openInApp();
                }}
                className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[var(--ink)] hover:bg-[var(--hover)] cursor-pointer"
              >
                <Globe size={13} className="shrink-0 text-[var(--accent)]" />
                <span className="truncate">Open in App Browser</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuPos(null);
                  openExternal();
                }}
                className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[var(--ink)] hover:bg-[var(--hover)] cursor-pointer"
              >
                <ExternalLink size={13} className="shrink-0 text-[var(--faint)]" />
                <span className="truncate">Open in System Browser</span>
              </button>
              <div className="my-1 border-t border-[var(--border)] opacity-60" />
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(resolved).then(() => {
                    setCopied(true);
                    setTimeout(() => {
                      setMenuPos(null);
                      setCopied(false);
                    }, 600);
                  });
                }}
                className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[var(--ink)] hover:bg-[var(--hover)] cursor-pointer"
              >
                {copied ? (
                  <Check size={13} className="shrink-0 text-[var(--accent)]" />
                ) : (
                  <Copy size={13} className="shrink-0 text-[var(--faint)]" />
                )}
                <span className="truncate">{copied ? "Copied Link!" : "Copy Link Address"}</span>
              </button>
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}

const URL_REGEX = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;

/** Linkifies raw URLs inside plain text messages (e.g. user chat turns). */
export function LinkifiedText({ text }: { text: string }) {
  if (!text || !URL_REGEX.test(text)) {
    return <>{text}</>;
  }

  URL_REGEX.lastIndex = 0;
  const parts = text.split(URL_REGEX);

  return (
    <>
      {parts.map((part, i) => {
        if (/^https?:\/\//.test(part)) {
          return (
            <ChatLink key={i} href={part}>
              {part}
            </ChatLink>
          );
        }
        return part;
      })}
    </>
  );
}

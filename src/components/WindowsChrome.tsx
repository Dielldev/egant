import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { runMenuAction } from "../lib/menuActions";
import { modShortcut } from "../lib/platform";
import { useEgant } from "../store";

const REPO = "https://github.com/Dielldev/egant";

type MenuItem = {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
};

type Menu = {
  label: string;
  mnemonic: string;
  items: (MenuItem | "separator")[];
};

/** Windows' custom title bar: an application menu on the left, window title and
 * drag strip in the center, and native-feeling caption buttons on the right.
 *
 * The window is undecorated on Windows (`tauri.windows.conf.json`) so the
 * webview can paint edge-to-edge over Mica / Mica Alt / Acrylic. */
export function WindowsChrome() {
  const barRef = useRef<HTMLElement>(null);
  const menuButtonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const lastEditable = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [at, setAt] = useState({ left: 0, top: 0 });
  const [maximized, setMaximized] = useState(false);
  const [altPressed, setAltPressed] = useState(false);

  const activeSessionId = useEgant((s) => s.snapshot?.activeSession ?? null);
  const sessionTitle = useEgant((s) => {
    const id = s.snapshot?.activeSession;
    if (id == null) return null;
    return s.snapshot?.sessions.find((sess) => sess.id === id)?.title ?? null;
  });

  useEffect(() => {
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        lastEditable.current = target;
      }
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = () => {
      void win
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(() => {});
    };
    sync();
    void win
      .onResized(sync)
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Track Alt key press for mnemonic highlights and handle Alt shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        setAltPressed(true);
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const key = e.key.toUpperCase();
        const targetMenu = menus.find((m) => m.mnemonic === key);
        if (targetMenu) {
          e.preventDefault();
          const idx = menus.indexOf(targetMenu);
          const btn = menuButtonsRef.current[idx];
          if (btn) showMenu(targetMenu.label, btn);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        setAltPressed(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // Close menu on outside click, window blur, or Escape
  useEffect(() => {
    if (open === null) return;
    const close = () => setOpen(null);
    const onPointerDown = (event: PointerEvent) => {
      if (!barRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        const currentIndex = menus.findIndex((m) => m.label === open);
        if (currentIndex === -1) return;
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const nextIndex = (currentIndex + delta + menus.length) % menus.length;
        const nextMenu = menus[nextIndex];
        const btn = menuButtonsRef.current[nextIndex];
        if (btn) showMenu(nextMenu.label, btn);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const focusEditor = () => {
    const active = document.activeElement;
    if (active === document.body || active instanceof HTMLButtonElement) {
      lastEditable.current?.focus();
    }
  };

  const edit = (command: "undo" | "redo" | "cut" | "copy" | "select-all") => {
    if (command !== "copy" && command !== "cut") focusEditor();
    document.execCommand(command === "select-all" ? "selectAll" : command);
  };

  const paste = async () => {
    focusEditor();
    try {
      const text = await navigator.clipboard.readText();
      if (text) document.execCommand("insertText", false, text);
    } catch {
      document.execCommand("paste");
    }
  };

  const win = getCurrentWindow();
  const maximize = () => {
    void win.toggleMaximize().catch(() => {});
  };
  const fullscreen = () => {
    void win
      .isFullscreen()
      .then((value) => win.setFullscreen(!value))
      .catch(() => {});
  };
  const url = (value: string) => () => void api.openUrl(value).catch(() => {});

  const menus: Menu[] = [
    {
      label: "File",
      mnemonic: "F",
      items: [
        {
          label: "New Conversation",
          shortcut: modShortcut("N"),
          onClick: () => runMenuAction("new-conversation"),
        },
        {
          label: "Open Folder…",
          shortcut: modShortcut("O"),
          onClick: () => runMenuAction("open-folder"),
        },
        { label: "Search…", shortcut: modShortcut("P"), onClick: () => runMenuAction("search") },
        "separator",
        {
          label: "Settings…",
          shortcut: modShortcut(","),
          onClick: () => runMenuAction("settings"),
        },
        "separator",
        {
          label: "Close Window",
          shortcut: "Alt+F4",
          onClick: () => void win.close().catch(() => {}),
        },
      ],
    },
    {
      label: "Edit",
      mnemonic: "E",
      items: [
        { label: "Undo", shortcut: modShortcut("Z"), onClick: () => edit("undo") },
        { label: "Redo", shortcut: modShortcut("Y"), onClick: () => edit("redo") },
        "separator",
        { label: "Cut", shortcut: modShortcut("X"), onClick: () => edit("cut") },
        { label: "Copy", shortcut: modShortcut("C"), onClick: () => edit("copy") },
        { label: "Paste", shortcut: modShortcut("V"), onClick: () => void paste() },
        {
          label: "Select All",
          shortcut: modShortcut("A"),
          onClick: () => edit("select-all"),
        },
      ],
    },
    {
      label: "View",
      mnemonic: "V",
      items: [
        {
          label: "Toggle Sidebar",
          shortcut: modShortcut("B"),
          onClick: () => runMenuAction("toggle-sidebar"),
        },
        {
          label: "Toggle Workspace Panel",
          shortcut: modShortcut("J"),
          onClick: () => runMenuAction("toggle-panel"),
        },
        {
          label: "Fill Window with Workspace Panel",
          shortcut: modShortcut("⇧J"),
          onClick: () => runMenuAction("toggle-panel-maximized"),
        },
        {
          label: "Library",
          shortcut: modShortcut("⇧L"),
          onClick: () => runMenuAction("library"),
        },
        "separator",
        {
          label: "Filter Conversations",
          shortcut: modShortcut("K"),
          onClick: () => runMenuAction("filter"),
        },
        {
          label: "Focus Message Box",
          shortcut: modShortcut("L"),
          onClick: () => runMenuAction("focus-composer"),
        },
        "separator",
        { label: "Zoom In", shortcut: modShortcut("="), onClick: () => runMenuAction("zoom-in") },
        {
          label: "Zoom Out",
          shortcut: modShortcut("-"),
          onClick: () => runMenuAction("zoom-out"),
        },
        {
          label: "Actual Size",
          shortcut: modShortcut("0"),
          onClick: () => runMenuAction("zoom-reset"),
        },
        "separator",
        { label: "Toggle Fullscreen", shortcut: "F11", onClick: fullscreen },
      ],
    },
    {
      label: "Conversation",
      mnemonic: "C",
      items: [
        {
          label: "Previous Conversation",
          onClick: () => runMenuAction("previous-conversation"),
        },
        { label: "Next Conversation", onClick: () => runMenuAction("next-conversation") },
        "separator",
        {
          label: "Stop Generating",
          shortcut: modShortcut("Esc"),
          onClick: () => runMenuAction("interrupt"),
        },
        {
          label: "Archive Conversation",
          disabled: activeSessionId == null,
          onClick: () => runMenuAction("archive-conversation"),
        },
      ],
    },
    {
      label: "Window",
      mnemonic: "W",
      items: [
        {
          label: "Minimize",
          onClick: () => void win.minimize().catch(() => {}),
        },
        {
          label: maximized ? "Restore" : "Maximize",
          onClick: maximize,
        },
        "separator",
        {
          label: "Close",
          shortcut: "Alt+F4",
          onClick: () => void win.close().catch(() => {}),
        },
      ],
    },
    {
      label: "Help",
      mnemonic: "H",
      items: [
        {
          label: "Keyboard Shortcuts",
          onClick: () => runMenuAction("shortcuts"),
        },
        {
          label: "Check for Updates…",
          onClick: () => runMenuAction("check-updates"),
        },
        "separator",
        { label: "Release Notes", onClick: url(`${REPO}/releases/latest`) },
        { label: "egant on GitHub", onClick: url(REPO) },
        { label: "Report an Issue…", onClick: url(`${REPO}/issues/new`) },
      ],
    },
  ];

  const showMenu = (label: string, button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    const width = 280;
    setAt({
      left: Math.max(4, Math.min(rect.left, window.innerWidth - width - 8)),
      top: rect.bottom + 2,
    });
    setOpen(label);
  };

  const openMenu = menus.find((menu) => menu.label === open);

  return (
    <header
      ref={barRef}
      data-tauri-drag-region
      className="windows-titlebar relative z-50 flex h-[32px] w-full shrink-0 items-center justify-between select-none"
    >
      {/* Left: App Logo + Compact Menubar */}
      <div className="flex h-full items-center pl-2.5" data-tauri-no-drag>
        <span className="mr-2 flex items-center opacity-80" title="egant">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)]">
            <polygon points="12 2 2 7 12 12 22 7 12 2" />
            <polyline points="2 17 12 22 22 17" />
            <polyline points="2 12 12 17 22 12" />
          </svg>
        </span>
        <nav role="menubar" aria-label="Application menu" className="flex h-full items-center gap-0.5">
          {menus.map((menu, idx) => {
            const isOpen = open === menu.label;
            const label = menu.label;
            return (
              <button
                key={menu.label}
                ref={(el) => {
                  menuButtonsRef.current[idx] = el;
                }}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  if (isOpen) setOpen(null);
                  else showMenu(menu.label, event.currentTarget);
                }}
                onMouseEnter={(event) => {
                  if (open !== null) showMenu(menu.label, event.currentTarget);
                }}
                className={`h-[24px] cursor-default rounded px-2 text-[12px] font-normal transition-colors ${
                  isOpen
                    ? "bg-[var(--hover)] text-[var(--ink)]"
                    : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                }`}
              >
                {altPressed ? (
                  <span>
                    <u>{label[0]}</u>
                    {label.slice(1)}
                  </span>
                ) : (
                  label
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Center: Draggable title strip */}
      <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center justify-center px-4">
        <span className="pointer-events-none truncate text-[11.5px] font-medium tracking-tight text-[var(--faint)] opacity-75">
          {sessionTitle ? `${sessionTitle} — egant` : "egant"}
        </span>
      </div>

      {/* Right: Caption Buttons (Minimize, Maximize/Restore, Close) */}
      <div className="flex h-full items-stretch" data-tauri-no-drag>
        <CaptionButton label="Minimize" onClick={() => void win.minimize().catch(() => {})}>
          <MinimizeGlyph />
        </CaptionButton>
        <CaptionButton
          label={maximized ? "Restore" : "Maximize"}
          onClick={maximize}
        >
          {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
        </CaptionButton>
        <CaptionButton label="Close" close onClick={() => void win.close().catch(() => {})}>
          <CloseGlyph />
        </CaptionButton>
      </div>

      {/* Dropdown Popover */}
      {openMenu && (
        <div
          role="menu"
          aria-label={openMenu.label}
          className="menu menu-pop fixed z-[100] max-h-[calc(100vh-44px)] w-[280px] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--card)]/95 p-1 text-[12.5px] shadow-2xl backdrop-blur-md"
          style={{ left: at.left, top: at.top }}
        >
          {openMenu.items.map((item, index) =>
            item === "separator" ? (
              <div
                key={`separator-${index}`}
                role="separator"
                className="my-1 h-px bg-[var(--border)] opacity-60"
              />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setOpen(null);
                  item.onClick();
                }}
                className="flex h-[28px] w-full cursor-default items-center justify-between gap-4 rounded-lg px-2.5 text-left text-[var(--ink)] hover:bg-[var(--hover)] disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent"
              >
                <span className="truncate">{item.label}</span>
                {item.shortcut && (
                  <span className="shrink-0 font-mono text-[11px] text-[var(--faint)]">
                    {item.shortcut}
                  </span>
                )}
              </button>
            ),
          )}
        </div>
      )}
    </header>
  );
}

function CaptionButton({
  label,
  close,
  onClick,
  children,
}: {
  label: string;
  close?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      tabIndex={-1}
      data-tauri-no-drag
      onClick={onClick}
      className={`caption-button flex h-full w-[46px] items-center justify-center text-[var(--muted)] ${
        close ? "caption-close" : ""
      }`}
    >
      {children}
    </button>
  );
}

function MinimizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none">
      <path d="M0.5 5.5h9" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none">
      <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function RestoreGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none">
      <path d="M2.5 2.5v-2h7v7h-2" stroke="currentColor" strokeWidth="1" />
      <rect x="0.5" y="2.5" width="7" height="7" rx="0.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none">
      <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

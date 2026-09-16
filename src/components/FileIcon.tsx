import {
  AntigravityIcon,
  DEFAULT_FILE_ICON,
  FOLDER_ICON,
  FOLDER_OPEN_ICON,
  ICON_BY_EXTENSION,
  ICON_BY_FILENAME,
  hasIcon,
} from "./icons/antigravity";

/** Which icon a name resolves to, by the pack's own rules: the whole filename
 * first (`package.json` is npm's, not JSON's), then the longest compound
 * extension (`.config.ts` before `.ts`), then the plain extension. */
export function iconFor(name: string, isDir: boolean, open: boolean): string {
  if (isDir) return open ? FOLDER_OPEN_ICON : FOLDER_ICON;

  const lower = name.toLowerCase();
  const byName = ICON_BY_FILENAME[lower];
  if (byName) return byName;

  // `vite.config.ts` should be Vite's icon, not TypeScript's, so the longest
  // suffix wins: every dot in the name is a candidate, longest first.
  for (let dot = lower.indexOf("."); dot !== -1; dot = lower.indexOf(".", dot + 1)) {
    const byExtension = ICON_BY_EXTENSION[lower.slice(dot + 1)];
    if (byExtension) return byExtension;
  }

  // A dotfile with nothing matched (`.foorc`) is configuration more often than
  // it is prose.
  if (lower.startsWith(".") && hasIcon("gear")) return "gear";
  return DEFAULT_FILE_ICON;
}

/** The icon beside a file or folder in the tree, and on its stage tab. The
 * artwork is the Antigravity Icons Supercharged set, vendored — see
 * `icons/LICENSE.md`. Folders are the one thing drawn in the window's own
 * colour rather than the pack's fixed slate: there is one in every row of the
 * tree, and at that density they should recede into the palette. */
export function FileIcon({
  name,
  isDir = false,
  open = false,
  size = 15,
}: {
  name: string;
  isDir?: boolean;
  open?: boolean;
  size?: number;
}) {
  const icon = iconFor(name, isDir, open);
  return (
    <AntigravityIcon
      icon={icon}
      size={size}
      color={isDir ? "var(--faint)" : undefined}
    />
  );
}

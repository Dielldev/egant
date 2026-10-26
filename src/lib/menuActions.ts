/** The bridge between a menu bar and the window-wide action switch in `App`.
 *
 * The native menu reaches it through Tauri's `menu-action` event. Windows now
 * draws its own menu bar (the native one sits above a custom title bar), and
 * that bar is not inside the component that owns `perform`, so it reaches the
 * same switch through this one handler. Keeping both paths on `perform` means
 * a menu item can never drift from the keyboard shortcut beside it. */

type MenuActionHandler = (action: string) => void;

let handler: MenuActionHandler | null = null;

export function setMenuActionHandler(next: MenuActionHandler | null): void {
  handler = next;
}

export function runMenuAction(action: string): void {
  handler?.(action);
}

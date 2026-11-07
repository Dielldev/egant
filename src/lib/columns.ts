// Column sizing constants shared by `layout.ts` and the store. A leaf module:
// `layout.ts` imports the store, so the store can't import from it.

/** The least room the conversation column is given before something else
 * yields. Under this the composer's controls wrap onto a second row and the
 * header truncates the title to a few letters. */
export const MIN_STAGE_WIDTH = 440;

/** The narrowest the workspace panel can be dragged — mirrored by the store's
 * `setPanelWidth` clamp. */
export const MIN_PANEL_WIDTH = 240;

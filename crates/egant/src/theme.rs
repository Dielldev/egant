//! The shell's palette.
//!
//! The component library ships themes, but this window is darker and flatter
//! than any of its presets, and every surface that floats over the wallpaper has
//! to be translucent rather than filled. Bending the preset at forty call sites
//! would be worse than naming the colours once, so the shell reads them from
//! here and [`apply`] pushes the handful the component library needs — inputs,
//! selection, scrollbars — back into its theme so built-in controls match.

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::{App, Hsla, Window, hsla, rgb};

/// White at a given alpha — the whole design is tints of it over dark.
pub fn white(alpha: f32) -> Hsla {
    hsla(0.0, 0.0, 1.0, alpha)
}

/// Black at a given alpha, for scrims.
pub fn black(alpha: f32) -> Hsla {
    hsla(0.0, 0.0, 0.0, alpha)
}

/// The icon rail on the far left — the darkest column.
pub fn rail() -> Hsla {
    with_alpha(rgb(0x0C0C0E).into(), 0.86)
}

/// The workspace column of sessions, a step lighter than the rail.
pub fn panel() -> Hsla {
    with_alpha(rgb(0x121214).into(), 0.82)
}

/// Fallback behind the stage when no wallpaper is set.
pub fn stage() -> Hsla {
    with_alpha(rgb(0x121216).into(), 0.88)
}

/// Hairlines between columns and under headers.
pub fn border() -> Hsla {
    white(0.06)
}

/// Body text.
pub fn ink() -> Hsla {
    rgb(0xE8E8ED).into()
}

/// Labels, secondary rows, placeholder text.
pub fn muted() -> Hsla {
    rgb(0x8C8C97).into()
}

/// Section headers and metadata — present, but never competing.
pub fn faint() -> Hsla {
    rgb(0x5E5E68).into()
}

/// A row under the pointer.
pub fn hover() -> Hsla {
    white(0.05)
}

/// The selected row in either rail.
pub fn selected() -> Hsla {
    white(0.08)
}

/// The composer and its chips: frosted, not filled, so the wallpaper reads
/// through.
pub fn glass() -> Hsla {
    white(0.07)
}

/// The composer's edge, one stop brighter than a rail hairline so the panel has
/// a shape of its own against a busy wallpaper.
pub fn glass_border() -> Hsla {
    white(0.10)
}

/// The one saturated colour in the shell: a session that is working.
pub fn busy() -> Hsla {
    rgb(0x6E8BF0).into()
}

/// Failed tool output and error notices. Desaturated well below a warning red —
/// it has to sit on a photograph without shouting.
pub fn danger() -> Hsla {
    rgb(0xE07070).into()
}

fn with_alpha(color: Hsla, alpha: f32) -> Hsla {
    Hsla { a: alpha, ..color }
}

/// Locks the component library to dark and retints the controls the shell
/// embeds, so a `Textarea` or `Button` dropped into the composer does not carry
/// the preset's lighter surfaces in with it.
pub fn apply(window: &mut Window, cx: &mut App) {
    Theme::change(ThemeMode::Dark, Some(window), cx);

    let theme = Theme::global_mut(cx);
    theme.radius = gpui_kit::px(8.);
    theme.radius_lg = gpui_kit::px(12.);
    // The focus ring is painted outside the element; the composer clips its
    // content, so a ring on the textarea would be cut in half.
    theme.focus_ring = false;
    theme.shadow = false;

    theme.background = stage();
    theme.foreground = ink();
    theme.border = border();
    theme.muted = white(0.06);
    theme.muted_foreground = muted();
    theme.accent = white(0.08);
    theme.accent_foreground = ink();
    theme.input = white(0.08);
    theme.ring = white(0.14);
    theme.caret = ink();
    theme.selection = busy().opacity(0.35);
    theme.scrollbar = gpui_kit::transparent_black();
    theme.scrollbar_thumb = white(0.12);
    theme.scrollbar_thumb_hover = white(0.2);
    theme.sidebar = panel();
    theme.sidebar_border = border();
    theme.sidebar_foreground = ink();
    theme.sidebar_accent = selected();
    theme.sidebar_accent_foreground = ink();
    theme.popover = with_alpha(rgb(0x18181C).into(), 0.98);
    theme.popover_foreground = ink();
    theme.title_bar = gpui_kit::transparent_black();
    theme.title_bar_border = gpui_kit::transparent_black();
    theme.tab_bar = gpui_kit::transparent_black();
    theme.tab_bar_segmented = white(0.05);
    theme.tab = gpui_kit::transparent_black();
    theme.tab_active = white(0.1);
    theme.tab_active_foreground = ink();
    theme.tab_foreground = muted();
}

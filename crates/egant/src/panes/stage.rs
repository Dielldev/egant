//! The wallpaper behind the session.
//!
//! Two layers rather than one: the image, and a scrim over it. The whole shell
//! above is translucent, so without the scrim the chrome would sit directly on a
//! photograph and the body text would be unreadable over anything but a dark
//! one. The scrim's strength is the `wallpaper_dim` setting.

use crate::theme;
use gpui_kit::prelude::*;
use gpui_kit::{AnyElement, ObjectFit, StyledImage, div, img};
use std::path::PathBuf;

/// The layers that go behind the stage's content.
///
/// Returned as elements rather than drawn here so the caller can place them in
/// its own stacking order — they are absolutely positioned and expect a
/// `relative` parent filling the stage.
pub fn wallpaper(path: Option<&PathBuf>, dim: f32) -> AnyElement {
    let Some(path) = path.cloned() else {
        // No wallpaper: the flat chrome colour, so the stage still reads as a
        // surface rather than as a hole in the window.
        return div()
            .absolute()
            .inset_0()
            .bg(theme::stage())
            .into_any_element();
    };

    div()
        .absolute()
        .inset_0()
        // Clipped, because `Cover` scales the image past the stage on whichever
        // axis does not match its aspect ratio.
        .overflow_hidden()
        .child(
            img(path)
                .absolute()
                .inset_0()
                .size_full()
                .object_fit(ObjectFit::Cover),
        )
        .child(div().absolute().inset_0().bg(theme::black(dim)))
        .into_any_element()
}

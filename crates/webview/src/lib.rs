//! A platform webview hosted inside the GPUI window.
//!
//! GPUI draws everything itself and has no webview element, so an in-app
//! browser has to be a real native view — on macOS a `WKWebView` — added as a
//! child of the window GPUI already owns. `wry` builds exactly that from a
//! `raw-window-handle`, which GPUI's window provides.
//!
//! Two consequences are worth knowing before building UI around this:
//!
//! 1. **The webview is not part of GPUI's scene.** It is a sibling native view
//!    composited by the window server *above* everything GPUI paints. Nothing
//!    GPUI draws — a dropdown, a modal, a tooltip — can appear over it. Plan the
//!    layout so the browser pane never needs to be overlapped, or hide the
//!    webview ([`WebviewPane::set_visible`]) while an overlay is open.
//!
//! 2. **Its position is not laid out by GPUI.** The pane has to be told its
//!    rectangle whenever layout changes, in window coordinates. The app does
//!    this from its render pass; see `panes::browser`.
//!
//! The type is compiled in both configurations: with the `webview` feature it
//! drives `wry`, and without it every method is a no-op so the rest of the app
//! needs no `cfg` of its own.

use anyhow::Result;

#[cfg(feature = "webview")]
use raw_window_handle::HasWindowHandle;

/// Position and size of the pane, in physical pixels relative to the window.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct PaneRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl PaneRect {
    pub fn new(x: f32, y: f32, width: f32, height: f32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

pub struct WebviewPane {
    #[cfg(feature = "webview")]
    inner: wry::WebView,
    url: String,
    bounds: PaneRect,
    visible: bool,
}

impl WebviewPane {
    /// Builds a webview as a child of `window`.
    ///
    /// `window` is the GPUI window handle. Must be called on the main thread —
    /// the platform requires it, and GPUI's render pass already runs there.
    #[cfg(feature = "webview")]
    pub fn new(window: &impl HasWindowHandle, url: impl Into<String>) -> Result<Self> {
        use wry::WebViewBuilder;
        use wry::dpi::{LogicalPosition, LogicalSize};

        let url = url.into();
        let inner = WebViewBuilder::new()
            .with_url(&url)
            .with_bounds(wry::Rect {
                position: LogicalPosition::new(0, 0).into(),
                size: LogicalSize::new(1, 1).into(),
            })
            .build_as_child(window)?;

        Ok(Self {
            inner,
            url,
            bounds: PaneRect::default(),
            visible: true,
        })
    }

    #[cfg(not(feature = "webview"))]
    pub fn new<W>(_window: &W, url: impl Into<String>) -> Result<Self> {
        Ok(Self {
            url: url.into(),
            bounds: PaneRect::default(),
            visible: true,
        })
    }

    /// Moves the native view to match where GPUI laid the pane out. Cheap to
    /// call every frame: it returns early unless the rectangle moved.
    pub fn set_bounds(&mut self, bounds: PaneRect) -> Result<()> {
        if self.bounds == bounds {
            return Ok(());
        }
        self.bounds = bounds;

        #[cfg(feature = "webview")]
        {
            use wry::dpi::{LogicalPosition, LogicalSize};
            self.inner.set_bounds(wry::Rect {
                position: LogicalPosition::new(bounds.x, bounds.y).into(),
                size: LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)).into(),
            })?;
        }
        Ok(())
    }

    /// Hide the webview while a GPUI overlay needs to draw over its area. See
    /// the note about compositing at the top of this module.
    pub fn set_visible(&mut self, visible: bool) -> Result<()> {
        if self.visible == visible {
            return Ok(());
        }
        self.visible = visible;

        #[cfg(feature = "webview")]
        self.inner.set_visible(visible)?;
        Ok(())
    }

    pub fn is_visible(&self) -> bool {
        self.visible
    }

    pub fn navigate(&mut self, url: impl Into<String>) -> Result<()> {
        let url = url.into();

        #[cfg(feature = "webview")]
        self.inner.load_url(&url)?;

        self.url = url;
        Ok(())
    }

    pub fn reload(&self) -> Result<()> {
        #[cfg(feature = "webview")]
        self.inner.evaluate_script("location.reload()")?;
        Ok(())
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    /// True when a real webview is behind this handle. The browser pane shows a
    /// build-time explanation when it is false, rather than a blank rectangle.
    pub const fn is_available() -> bool {
        cfg!(feature = "webview")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn availability_tracks_the_feature() {
        assert_eq!(WebviewPane::is_available(), cfg!(feature = "webview"));
    }

    #[test]
    fn rect_equality_drives_the_early_return() {
        let a = PaneRect::new(0.0, 0.0, 100.0, 100.0);
        let b = PaneRect::new(0.0, 0.0, 100.0, 100.0);
        assert_eq!(a, b);
        assert_ne!(a, PaneRect::new(1.0, 0.0, 100.0, 100.0));
    }
}

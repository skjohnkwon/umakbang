//! The five sizes the user drags: the sidebar's width, where its tag strip ends, the visualizer
//! panel's width, the transport's height and where its controls give way to the waveform.
//!
//! Limits and defaults are the Electron app's own (`Sidebar.tsx`, `NowPlayingPanel.tsx`,
//! `NowPlayingBar.tsx`, `lib/layout.ts`), and a launch with no saved layout of its own starts
//! from the sizes the Electron app last had - so the two open looking the same.
//!
//! Saved to a file of the native app's own rather than written into `umakbang-data.json`. That
//! document is the Electron app's, written whole from its memory; two writers of one file is
//! how edits get lost.

use crate::userdata::Settings;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The narrowest the file table may be squeezed to (`MIN_TABLE_WIDTH`).
const MIN_TABLE_WIDTH: f32 = 280.0;

const SIDEBAR: (f32, f32) = (150.0, 220.0);
const PANEL: (f32, f32) = (220.0, 300.0);
const TAGS: (f32, f32, f32) = (28.0, 520.0, 92.0);
const PLAYER: (f32, f32, f32) = (92.0, 320.0, 112.0);
const SPLIT: (f32, f32, f32) = (250.0, 900.0, 430.0);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Handle {
    Sidebar,
    Tags,
    Panel,
    Player,
    Split,
}

impl Handle {
    /// Along which axis the pointer moves it: true for a width.
    pub fn horizontal(self) -> bool {
        matches!(self, Handle::Sidebar | Handle::Panel | Handle::Split)
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub sidebar_width: f32,
    pub tags_height: f32,
    pub panel_width: f32,
    pub player_height: f32,
    pub player_split: f32,
}

/// What is actually drawn, after the window has had its say.
#[derive(Clone, Copy, Debug)]
pub struct Sizes {
    pub sidebar: f32,
    pub tags: f32,
    pub panel: f32,
    pub player: f32,
    pub split: f32,
}

/// `maxPanelWidth`: whatever the other panel and a readable table leave, never below the minimum.
fn max_panel(min: f32, window: f32, occupied: f32) -> f32 {
    min.max((window - occupied - MIN_TABLE_WIDTH).round())
}

impl Layout {
    /// The Electron app's saved sizes, or its defaults where it has none.
    pub fn from_settings(s: &Settings) -> Layout {
        Layout {
            sidebar_width: s.sidebar_width.unwrap_or(345.0),
            tags_height: s.tags_height.unwrap_or(92.0),
            panel_width: s.panel_width.unwrap_or(576.0),
            player_height: s.player_height.unwrap_or(118.0),
            player_split: s.player_split.unwrap_or(318.0),
        }
    }

    pub fn load(path: &Path) -> Option<Layout> {
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
    }

    /// Written through a temporary file, so a crash mid-write leaves the last good layout.
    pub fn save(&self, path: &Path) {
        let Ok(raw) = serde_json::to_string_pretty(self) else { return };
        let part = path.with_extension("json.part");
        if std::fs::write(&part, raw).is_ok() {
            let _ = std::fs::rename(&part, path);
        }
    }

    /// The sizes on screen in a window `window` wide. The widths are clamped on the way out as
    /// well as while dragging: one that was legal when it was dragged has to give way when the
    /// window shrinks under it, or its handle ends up somewhere nothing can reach.
    pub fn sizes(&self, window: f32) -> Sizes {
        Sizes {
            sidebar: self.sidebar_width.min(max_panel(SIDEBAR.0, window, self.panel_width)),
            tags: self.tags_height,
            panel: self.panel_width.min(max_panel(PANEL.0, window, self.sidebar_width)),
            player: self.player_height.clamp(PLAYER.0, PLAYER.1),
            split: self.player_split.clamp(SPLIT.0, SPLIT.1),
        }
    }

    /// The value a drag starts from: what is on screen, as each component reads it.
    pub fn start(&self, handle: Handle, window: f32) -> f32 {
        let sizes = self.sizes(window);
        match handle {
            Handle::Sidebar => sizes.sidebar,
            Handle::Panel => sizes.panel,
            Handle::Tags => self.tags_height,
            Handle::Player => self.player_height,
            Handle::Split => self.player_split,
        }
    }

    /// `delta` logical pixels of pointer travel since a drag began at `start`. The panel and the
    /// transport are anchored to the far edge, so travel towards them makes them smaller.
    pub fn drag(&mut self, handle: Handle, start: f32, delta: f32, window: f32) {
        match handle {
            Handle::Sidebar => {
                let max = max_panel(SIDEBAR.0, window, self.panel_width);
                self.sidebar_width = (start + delta).round().clamp(SIDEBAR.0, max);
            }
            Handle::Panel => {
                let max = max_panel(PANEL.0, window, self.sidebar_width);
                self.panel_width = (start - delta).round().clamp(PANEL.0, max);
            }
            Handle::Tags => self.tags_height = (start + delta).round().clamp(TAGS.0, TAGS.1),
            Handle::Player => self.player_height = (start - delta).round().clamp(PLAYER.0, PLAYER.1),
            Handle::Split => self.player_split = (start + delta).round().clamp(SPLIT.0, SPLIT.1),
        }
    }

    /// A double-click on a handle: back to the component's default.
    pub fn reset(&mut self, handle: Handle) {
        match handle {
            Handle::Sidebar => self.sidebar_width = SIDEBAR.1,
            Handle::Panel => self.panel_width = PANEL.1,
            Handle::Tags => self.tags_height = TAGS.2,
            Handle::Player => self.player_height = PLAYER.2,
            Handle::Split => self.player_split = SPLIT.2,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> Layout {
        Layout { sidebar_width: 255.0, tags_height: 357.0, panel_width: 625.0, player_height: 162.0, player_split: 313.0 }
    }

    #[test]
    fn widths_give_way_to_a_narrow_window() {
        // 1000 - 625 - 280 leaves the sidebar 95, under its floor of 150.
        assert_eq!(layout().sizes(1000.0).sidebar, 150.0);
        // 1000 - 255 - 280 = 465 for the panel.
        assert_eq!(layout().sizes(1000.0).panel, 465.0);
        assert_eq!(layout().sizes(1600.0).panel, 625.0);
    }

    #[test]
    fn far_edge_panels_grow_against_the_pointer() {
        let mut l = layout();
        l.drag(Handle::Panel, 625.0, -40.0, 1600.0);
        assert_eq!(l.panel_width, 665.0);
        l.drag(Handle::Player, 162.0, 500.0, 1600.0);
        assert_eq!(l.player_height, 92.0);
        l.drag(Handle::Sidebar, 255.0, 30.4, 1600.0);
        assert_eq!(l.sidebar_width, 285.0);
    }
}

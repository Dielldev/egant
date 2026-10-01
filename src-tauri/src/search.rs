//! The search window's look inside conversations: every open session's
//! messages — what was asked, what the agent answered, the notices between —
//! matched case-insensitively, each hit with a snippet around it and enough
//! to find the message again in the window (`ordinal`, see [`SearchHitDto`]).
//!
//! Tool output is left out on purpose: a match in a file the agent read is
//! almost never the conversation someone is looking for, and there is a lot
//! more of it than of anything said.

use std::sync::Mutex;

use egant_harness::TranscriptEntry;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::state::AppState;

/// Hits shown per session, and in all: enough to tell which conversation it
/// was, not every mention in a long one.
const HITS_PER_SESSION: usize = 3;
const HITS_IN_ALL: usize = 60;

/// How much of the text either side of a match the snippet keeps.
const CONTEXT_BEFORE: usize = 48;
const CONTEXT_AFTER: usize = 96;

/// One message that matched. `kind` is `user`, `assistant` or `notice`, and
/// `ordinal` which one of that kind it is, counted from 0 in the session's
/// transcript — how the window finds it again, since its own copy splits
/// some replies differently. The snippet comes in three pieces so the window
/// can mark the match without counting bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHitDto {
    pub session_id: u64,
    pub kind: &'static str,
    pub ordinal: usize,
    pub before: String,
    pub matched: String,
    pub after: String,
}

/// Every open session's messages matching `query`, newest session first.
#[tauri::command]
pub async fn search_transcripts(
    app: AppHandle,
    query: String,
) -> Result<Vec<SearchHitDto>, String> {
    let needle = query.trim().to_lowercase();
    if needle.chars().count() < 2 {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<AppState>>();
        let guard = state
            .lock()
            .map_err(|_| "the app state is unavailable".to_string())?;
        let mut hits = Vec::new();
        for id in guard.order.iter().rev() {
            let Some(session) = guard.sessions.get(id) else {
                continue;
            };
            let room = HITS_IN_ALL - hits.len();
            hits.extend(search_entries(
                *id,
                &session.transcript.entries,
                &needle,
                room,
            ));
            if hits.len() >= HITS_IN_ALL {
                break;
            }
        }
        Ok(hits)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// One session's matches for an already lowercased `needle`, at most `room`
/// of them (and never more than [`HITS_PER_SESSION`]).
pub fn search_entries(
    session_id: u64,
    entries: &[TranscriptEntry],
    needle: &str,
    room: usize,
) -> Vec<SearchHitDto> {
    let limit = room.min(HITS_PER_SESSION);
    let mut hits = Vec::new();
    let (mut users, mut replies, mut notices) = (0, 0, 0);
    for entry in entries {
        let (kind, ordinal, text) = match entry {
            TranscriptEntry::User { text } => ("user", bump(&mut users), text),
            TranscriptEntry::Assistant { text, .. } => ("assistant", bump(&mut replies), text),
            TranscriptEntry::Notice { text, .. } => ("notice", bump(&mut notices), text),
            _ => continue,
        };
        if hits.len() >= limit {
            break;
        }
        if let Some((start, end)) = find_ignoring_case(text, needle) {
            let (before, matched, after) = snippet(text, start, end);
            hits.push(SearchHitDto {
                session_id,
                kind,
                ordinal,
                before,
                matched,
                after,
            });
        }
    }
    hits
}

fn bump(count: &mut usize) -> usize {
    *count += 1;
    *count - 1
}

/// Where `needle` (lowercase) first appears in `text`, as a byte range of
/// `text` itself — lowercasing can change a character's length, so the
/// match is found in a lowercased copy and mapped back.
fn find_ignoring_case(text: &str, needle: &str) -> Option<(usize, usize)> {
    let mut lowered = String::with_capacity(text.len());
    // For each byte of `lowered`, where its character starts in `text`.
    let mut origin = Vec::with_capacity(text.len() + 1);
    for (at, c) in text.char_indices() {
        for lower in c.to_lowercase() {
            let from = lowered.len();
            lowered.push(lower);
            origin.extend(std::iter::repeat_n(at, lowered.len() - from));
        }
    }
    origin.push(text.len());
    let start = lowered.find(needle)?;
    let end = start + needle.len();
    let original_end = origin[end..]
        .iter()
        .copied()
        .find(|&at| at > origin[start])
        .unwrap_or(text.len());
    Some((origin[start], original_end))
}

/// The match with some text either side, whitespace run together, cut at
/// characters and marked with an ellipsis where it was cut.
fn snippet(text: &str, start: usize, end: usize) -> (String, String, String) {
    let flat = |part: &str| part.split_whitespace().collect::<Vec<_>>().join(" ");
    let before_text = &text[..start];
    let after_text = &text[end..];
    let mut before = flat(before_text);
    let count = before.chars().count();
    if count > CONTEXT_BEFORE {
        before = format!(
            "…{}",
            before
                .chars()
                .skip(count - CONTEXT_BEFORE)
                .collect::<String>()
        );
    }
    if before_text.ends_with(char::is_whitespace) && !before.is_empty() {
        before.push(' ');
    }
    let mut after = flat(after_text);
    if after.chars().count() > CONTEXT_AFTER {
        after = format!("{}…", after.chars().take(CONTEXT_AFTER).collect::<String>());
    }
    if after_text.starts_with(char::is_whitespace) && !after.is_empty() {
        after.insert(0, ' ');
    }
    (before, text[start..end].to_string(), after)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(text: &str) -> TranscriptEntry {
        TranscriptEntry::User { text: text.into() }
    }

    fn reply(text: &str) -> TranscriptEntry {
        TranscriptEntry::Assistant {
            text: text.into(),
            streaming: false,
        }
    }

    #[test]
    fn a_match_says_which_message_and_shows_it_in_context() {
        let entries = vec![
            user("fix the login flow"),
            reply("Looking at the Login form now."),
            user("and the signup"),
            reply("The   signup\nform uses the same LOGIN check."),
        ];
        let hits = search_entries(7, &entries, "login", 10);
        assert_eq!(hits.len(), 3);
        assert_eq!((hits[0].kind, hits[0].ordinal), ("user", 0));
        assert_eq!((hits[1].kind, hits[1].ordinal), ("assistant", 0));
        assert_eq!(hits[1].matched, "Login");
        assert_eq!((hits[2].kind, hits[2].ordinal), ("assistant", 1));
        assert_eq!(hits[2].before, "The signup form uses the same ");
        assert_eq!(hits[2].matched, "LOGIN");
        assert_eq!(hits[2].after, " check.");
    }

    #[test]
    fn a_long_conversation_gives_a_few_hits_not_all() {
        let entries: Vec<_> = (0..20).map(|n| user(&format!("deploy step {n}"))).collect();
        assert_eq!(
            search_entries(1, &entries, "deploy", 10).len(),
            HITS_PER_SESSION
        );
        assert_eq!(search_entries(1, &entries, "deploy", 1).len(), 1);
    }

    #[test]
    fn case_is_ignored_even_where_lowercase_changes_length() {
        // "İ" lowercases to two characters; the match must still be cut from
        // the original text at the right place.
        let (start, end) = find_ignoring_case("Kaİstanbul trip", "stanbul").unwrap();
        assert_eq!(&"Kaİstanbul trip"[start..end], "stanbul");
        let (start, end) =
            find_ignoring_case("Größe ändern", "ÄNDERN".to_lowercase().as_str()).unwrap();
        assert_eq!(&"Größe ändern"[start..end], "ändern");
    }

    #[test]
    fn long_text_is_cut_to_a_snippet() {
        let text = format!("{} needle {}", "a ".repeat(100), "b ".repeat(100));
        let hits = search_entries(1, &[user(&text)], "needle", 10);
        assert!(hits[0].before.starts_with('…'));
        assert!(hits[0].after.ends_with('…'));
        assert!(hits[0].before.chars().count() <= CONTEXT_BEFORE + 2);
    }
}

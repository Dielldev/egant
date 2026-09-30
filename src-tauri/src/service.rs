//! The session operations more than one client can perform.
//!
//! The desktop window and a paired phone both start chats, send turns, stop
//! them, switch models and answer prompts. Each operation lives here once:
//! the Tauri command and the phone's HTTP handler are thin callers, and every
//! change is published to [`crate::sync`] as it is made, so whichever client
//! did not cause it hears about it.
//!
//! Every function takes the `AppState` the caller has already locked, and
//! publishes before returning — under that same lock (see `crate::sync`).

use egant_harness::{AgentId, PermissionMode};
use serde_json::Value;
use std::path::PathBuf;
use tauri::AppHandle;

use crate::sessions::{self, PermissionAnswer};
use crate::state::AppState;
use crate::sync::{self, Origin};
use crate::worktrees::SessionWorktree;

fn entry_count(state: &AppState, id: u64) -> usize {
    state
        .sessions
        .get(&id)
        .map_or(0, |session| session.transcript.entries.len())
}

/// Sends a turn (reviving the agent first if it has exited), returning the
/// session's new title when this turn named it. See [`sessions::send_text`].
pub fn send_message(
    app: &AppHandle,
    state: &mut AppState,
    id: u64,
    text: String,
    images: Vec<PathBuf>,
    origin: &Origin,
) -> Result<Option<String>, String> {
    let before = entry_count(state, id);
    let title = sessions::send_text(app, state, id, text, images)?;
    sync::transcript_grew(app, state, id, before, origin);
    sync::session_touched(app, state, id, origin);
    Ok(title)
}

/// Starts a chat session in a project the Mac already has open, in `mode`.
///
/// For a client other than the window, the window's own selection is left
/// where it was: starting a chat from the phone must not pull the desktop
/// off the conversation it is showing. The window still hears about the new
/// row through [`sync::session_touched`].
#[allow(clippy::too_many_arguments)]
pub fn start_session(
    app: &AppHandle,
    state: &mut AppState,
    project_id: usize,
    agent: AgentId,
    model: Option<String>,
    variant: Option<String>,
    mode: PermissionMode,
    worktree: Option<SessionWorktree>,
    device: Option<String>,
    origin: &Origin,
) -> Result<u64, String> {
    let selection = (state.active_session, state.active_project);
    let id = sessions::spawn_session(
        app, state, project_id, agent, model, variant, None, worktree,
    )?;
    if !matches!(origin, Origin::Desktop) {
        (state.active_session, state.active_project) = selection;
    }
    if let Some(session) = state.sessions.get_mut(&id) {
        session.meta.device = device;
    }
    if mode != PermissionMode::Auto {
        sessions::set_permission_mode(state, id, mode)?;
    }
    sync::session_touched(app, state, id, origin);
    Ok(id)
}

/// Moves a chat session onto another model and effort, keeping the context
/// window it asked for. See [`sessions::set_model`].
pub fn set_model(
    app: &AppHandle,
    state: &mut AppState,
    id: u64,
    model: Option<String>,
    variant: Option<String>,
    origin: &Origin,
) -> Result<(), String> {
    let context = state
        .sessions
        .get(&id)
        .ok_or_else(|| "unknown session".to_string())?
        .meta
        .context;
    sessions::set_model(app, state, id, model, variant, context)?;
    sync::session_touched(app, state, id, origin);
    // The transcript's model badge moved too; clients holding it refetch.
    sync::transcript_reset(app, id, origin);
    Ok(())
}

pub fn set_permission_mode(
    app: &AppHandle,
    state: &mut AppState,
    id: u64,
    mode: PermissionMode,
    origin: &Origin,
) -> Result<&'static str, String> {
    let applied = sessions::set_permission_mode(state, id, mode)?;
    sync::session_touched(app, state, id, origin);
    Ok(applied)
}

pub fn interrupt(
    app: &AppHandle,
    state: &mut AppState,
    id: u64,
    origin: &Origin,
) -> Result<(), String> {
    sessions::interrupt(state, id)?;
    sync::interrupted(app, id, origin);
    Ok(())
}

/// Answers one permission request. Returns the session's new mode when the
/// answer changed it (Allow always). See [`sessions::answer_permission`].
pub fn answer_permission(
    app: &AppHandle,
    state: &mut AppState,
    id: u64,
    request_id: &str,
    answer: PermissionAnswer,
    origin: &Origin,
) -> Result<Option<&'static str>, String> {
    let before = entry_count(state, id);
    let mode = sessions::answer_permission(state, id, request_id, answer)?;
    // opencode's Allow retries the last turn, which appends it again.
    sync::transcript_grew(app, state, id, before, origin);
    sync::permissions(app, state, id, origin);
    sync::session_touched(app, state, id, origin);
    Ok(mode)
}

/// Whether a decision answer went out.
#[derive(Debug, PartialEq, Eq)]
pub enum DecisionOutcome {
    /// Recorded and sent; carries the session's new title when the reply
    /// named it.
    Sent(Option<String>),
    /// Another client got there first. Nothing was sent: the agent must never
    /// hear the same decision twice.
    AlreadyAnswered,
}

/// Answers a decision prompt: records `response` against `decision_id` and
/// sends `text` — the reply the agent reads — as the next turn.
///
/// The check and the record happen under the caller's lock, so two clients
/// answering the same prompt at once cannot both send. A send that fails
/// takes the record back out, leaving the prompt answerable.
pub fn answer_decision(
    app: &AppHandle,
    state: &mut AppState,
    id: u64,
    decision_id: &str,
    response: Value,
    text: String,
    origin: &Origin,
) -> Result<DecisionOutcome, String> {
    let Some(session) = state.sessions.get_mut(&id) else {
        return Err("unknown session".to_string());
    };
    if session.decisions.contains_key(decision_id) {
        return Ok(DecisionOutcome::AlreadyAnswered);
    }
    session
        .decisions
        .insert(decision_id.to_string(), response.clone());
    let before = entry_count(state, id);
    let sent = send_message(app, state, id, text, Vec::new(), origin);
    // `send_text` can decline without an error (a session that ended under
    // it); only a turn that actually landed counts as the answer going out.
    let landed = entry_count(state, id) > before;
    match sent {
        Ok(title) if landed => {
            // `send_text` already saved the session, answer included.
            sync::decision(app, id, decision_id, &response, origin);
            Ok(DecisionOutcome::Sent(title))
        }
        outcome => {
            if let Some(session) = state.sessions.get_mut(&id) {
                session.decisions.remove(decision_id);
            }
            state.persist_session(id);
            Err(outcome
                .err()
                .unwrap_or_else(|| "this session has ended — the answer was not sent".to_string()))
        }
    }
}

/// Records decision answers the desktop window kept before the backend did,
/// without sending anything — they were sent when they were given. Answers
/// already on record win.
pub fn import_decisions(
    app: &AppHandle,
    state: &mut AppState,
    answers: Vec<(u64, String, Value)>,
) -> usize {
    let mut touched = std::collections::BTreeSet::new();
    for (id, decision_id, response) in answers {
        let Some(session) = state.sessions.get_mut(&id) else {
            continue;
        };
        if session.decisions.contains_key(&decision_id) {
            continue;
        }
        session
            .decisions
            .insert(decision_id.clone(), response.clone());
        sync::decision(app, id, &decision_id, &response, &Origin::Desktop);
        touched.insert(id);
    }
    for id in &touched {
        state.persist_session(*id);
    }
    touched.len()
}

/// Whether `response` has the shape of a decision answer: what the phone and
/// the window both send, and all the backend ever stores.
pub fn is_decision_response(response: &Value) -> bool {
    let Some(object) = response.as_object() else {
        return false;
    };
    let ids_ok = object
        .get("selectedOptionIds")
        .and_then(Value::as_array)
        .is_some_and(|ids| {
            ids.len() <= 64
                && ids
                    .iter()
                    .all(|id| id.as_str().is_some_and(|s| s.len() <= 200))
        });
    let custom_ok = object
        .get("customText")
        .is_none_or(|text| text.as_str().is_some_and(|s| s.len() <= 10_000));
    object.get("type").and_then(Value::as_str) == Some("decision") && ids_ok && custom_ok
}

#[cfg(test)]
mod tests {
    use super::is_decision_response;
    use serde_json::json;

    #[test]
    fn decision_answers_are_checked_for_shape() {
        assert!(is_decision_response(
            &json!({"type": "decision", "selectedOptionIds": ["a"]})
        ));
        assert!(is_decision_response(
            &json!({"type": "decision", "selectedOptionIds": [], "customText": "neither"})
        ));
        assert!(!is_decision_response(&json!({"selectedOptionIds": ["a"]})));
        assert!(!is_decision_response(
            &json!({"type": "decision", "selectedOptionIds": [1]})
        ));
        assert!(!is_decision_response(
            &json!({"type": "decision", "selectedOptionIds": ["a"], "customText": 3})
        ));
        assert!(!is_decision_response(&json!("decision")));
    }
}

//! The ordered record of what happens to sessions, for every client at once.
//!
//! The desktop window learns about a running turn through `session-event`, a
//! fire-and-forget Tauri event — all a window that is always there needs. A
//! phone is not always there. It sleeps mid-turn, drops off the tailnet and
//! comes back, and it has to pick up exactly where it left off. It also has to
//! hear about the things the window only ever learned from its own clicks: a
//! message typed on the other device, a permission answered there, a decision
//! picked there.
//!
//! So each of those changes is published here as an [`Envelope`] with a
//! sequence number, kept in a ring for replay, and broadcast to whoever is
//! listening (the phone API's event stream). The kinds the window does not
//! already hear through `session-event` are emitted to it as `session-sync`,
//! which is how a message sent from the phone shows up on the desktop.
//!
//! Callers publish while still holding the `AppState` lock the change was made
//! under. That is the whole consistency story: a snapshot read under the same
//! lock names the exact sequence number it reflects, so a client applies only
//! what comes after it — no gap, and no event folded in twice.

use serde_json::{Value, json};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast;

use crate::dto::{EventDto, pending_list, turn_state_name};
use crate::state::AppState;
use egant_harness::TranscriptEntry;

/// How many envelopes a reconnecting client can catch up on. A turn streams a
/// few thousand token deltas at most, so this covers a phone that slept
/// through one; anything older is answered with a `resync` instead.
const RING_CAPACITY: usize = 4096;

/// Tool output rides the phone's stream capped at this many bytes: exactly
/// what the tool cards show of it on the desktop too (`truncate(output, 4000)`
/// in `ToolCards.tsx`), so the phone draws the same card from a fraction of
/// the bytes. The real size travels alongside, so "… N more bytes" is still
/// honest.
pub const STREAM_OUTPUT_LIMIT: usize = 4000;

/// Who caused a change. Clients skip envelopes they caused themselves, since
/// they already applied those changes optimistically.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    /// The desktop window.
    Desktop,
    /// One page load of a paired phone: the id it sends as `X-Egant-Client`.
    Client(String),
    /// Nobody asked — the agent did it, or the app decided on its own.
    Agent,
}

impl Origin {
    fn to_value(&self) -> Value {
        match self {
            Origin::Desktop => Value::String("desktop".into()),
            Origin::Client(id) => Value::String(format!("client:{id}")),
            Origin::Agent => Value::Null,
        }
    }
}

/// One published change, serialized once however many clients read it.
#[derive(Debug)]
pub struct Envelope {
    pub seq: u64,
    pub json: Arc<str>,
    /// Set only on the internal signal that ends a revoked device's streams.
    /// Never stored in the ring and never sent to anyone.
    pub revoked_device: Option<String>,
}

/// What a stream needs to start: what it missed, whether it missed too much
/// to replay, and the live feed from here on.
pub struct Subscription {
    pub replay: Vec<Arc<Envelope>>,
    pub resync: bool,
    pub rx: broadcast::Receiver<Arc<Envelope>>,
}

struct Inner {
    seq: u64,
    ring: VecDeque<Arc<Envelope>>,
    /// Last published signature of each session's list row, so a row is only
    /// re-sent when something a list would draw actually changed.
    rows: HashMap<u64, u64>,
}

pub struct SyncHub {
    app: OnceLock<AppHandle>,
    /// Sequence numbers restart with the app, so a client that remembers one
    /// from a previous run must not replay against this run's ring.
    epoch: String,
    inner: Mutex<Inner>,
    tx: broadcast::Sender<Arc<Envelope>>,
}

impl SyncHub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(RING_CAPACITY);
        Self {
            app: OnceLock::new(),
            epoch: format!("{:x}", now_ms()),
            inner: Mutex::new(Inner {
                seq: 0,
                ring: VecDeque::with_capacity(RING_CAPACITY),
                rows: HashMap::new(),
            }),
            tx,
        }
    }

    /// Hands the hub the window it mirrors `session-sync` to. Separate from
    /// `new` because the hub is managed before the app has a handle to give.
    pub fn attach(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    /// The newest sequence number. Read it under the `AppState` lock to get
    /// the number a snapshot taken under that lock is consistent with.
    pub fn seq(&self) -> u64 {
        self.lock().seq
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn publish(
        &self,
        kind: &'static str,
        session_id: Option<u64>,
        origin: &Origin,
        payload: Value,
    ) -> u64 {
        let frame;
        let seq;
        {
            let mut inner = self.lock();
            inner.seq += 1;
            seq = inner.seq;
            frame = json!({
                "seq": seq,
                "ts": now_ms(),
                "type": kind,
                "sessionId": session_id,
                "origin": origin.to_value(),
                "payload": payload,
            });
            let envelope = Arc::new(Envelope {
                seq,
                json: frame.to_string().into(),
                revoked_device: None,
            });
            if inner.ring.len() == RING_CAPACITY {
                inner.ring.pop_front();
            }
            inner.ring.push_back(envelope.clone());
            // Sent under the lock so a subscriber (which subscribes under the
            // same lock) sees every envelope either in its replay or live.
            let _ = self.tx.send(envelope);
        }
        // The window already has harness events through `session-event`.
        if kind != "harness" {
            if let Some(app) = self.app.get() {
                let _ = app.emit("session-sync", frame);
            }
        }
        seq
    }

    /// Starts a stream after `since` (a sequence number from `epoch`). With no
    /// `since` the stream is live-only; a `since` from another run, or one the
    /// ring has already dropped, asks the client to resync instead.
    pub fn subscribe(&self, since: Option<u64>, epoch: Option<&str>) -> Subscription {
        let inner = self.lock();
        let rx = self.tx.subscribe();
        let mut replay = Vec::new();
        let mut resync = false;
        if let Some(since) = since {
            let oldest = inner.ring.front().map_or(inner.seq + 1, |e| e.seq);
            if epoch.is_some_and(|e| e != self.epoch) || since > inner.seq || since + 1 < oldest {
                resync = true;
            } else {
                replay = inner
                    .ring
                    .iter()
                    .filter(|e| e.seq > since)
                    .cloned()
                    .collect();
            }
        }
        Subscription { replay, resync, rx }
    }

    /// Ends every open stream of one device (or of all of them, with `*`).
    pub fn revoke_device(&self, device_id: &str) {
        let _ = self.tx.send(Arc::new(Envelope {
            seq: 0,
            json: Arc::from(""),
            revoked_device: Some(device_id.to_string()),
        }));
    }

    /// Whether a session's list row changed since it was last published.
    fn row_changed(&self, id: u64, signature: u64) -> bool {
        self.lock().rows.insert(id, signature) != Some(signature)
    }

    fn forget_row(&self, id: u64) {
        self.lock().rows.remove(&id);
    }
}

impl Default for SyncHub {
    fn default() -> Self {
        Self::new()
    }
}

fn hub(app: &AppHandle) -> Option<tauri::State<'_, SyncHub>> {
    app.try_state::<SyncHub>()
}

/// `(epoch, seq)` for a snapshot. Call with the `AppState` lock held.
pub fn position(app: &AppHandle) -> (String, u64) {
    match hub(app) {
        Some(hub) => (hub.epoch().to_string(), hub.seq()),
        None => (String::new(), 0),
    }
}

/// One harness event, as the phone folds it, with tool output capped (see
/// [`STREAM_OUTPUT_LIMIT`]).
pub fn harness_event(app: &AppHandle, id: u64, event: &EventDto) {
    let Some(hub) = hub(app) else { return };
    let mut payload = serde_json::to_value(event).unwrap_or(Value::Null);
    cap_tool_output(&mut payload);
    hub.publish("harness", Some(id), &Origin::Agent, payload);
}

fn cap_tool_output(payload: &mut Value) {
    if payload.get("type").and_then(Value::as_str) != Some("tool_result") {
        return;
    }
    let Some(output) = payload.get("output").and_then(Value::as_str) else {
        return;
    };
    if output.len() <= STREAM_OUTPUT_LIMIT {
        return;
    }
    let bytes = output.len();
    let head = utf8_prefix(output, STREAM_OUTPUT_LIMIT).to_string();
    payload["output"] = Value::String(head);
    payload["bytes"] = Value::from(bytes);
}

/// The longest prefix of `text` that fits in `limit` bytes without splitting
/// a character.
pub fn utf8_prefix(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// A user turn landed in a session's transcript.
pub fn user_message(app: &AppHandle, id: u64, text: &str, origin: &Origin) {
    let Some(hub) = hub(app) else { return };
    hub.publish("user_message", Some(id), origin, json!({ "text": text }));
}

/// Publishes whatever a command appended to a transcript outside the event
/// stream. The ordinary case is one user turn, which clients fold like any
/// other; anything else (opencode's approve-and-retry) is rare enough that
/// asking clients to refetch is simpler than describing it.
pub fn transcript_grew(app: &AppHandle, state: &AppState, id: u64, before: usize, origin: &Origin) {
    let Some(session) = state.sessions.get(&id) else {
        return;
    };
    let entries = &session.transcript.entries;
    if entries.len() == before {
        return;
    }
    if entries.len() == before + 1 {
        if let Some(TranscriptEntry::User { text }) = entries.last() {
            user_message(app, id, text, origin);
            return;
        }
    }
    transcript_reset(app, id, origin);
}

/// The permission table changed outside the event stream: it carries the
/// resulting turn state and table whole, so no client has to re-derive them.
pub fn permissions(app: &AppHandle, state: &AppState, id: u64, origin: &Origin) {
    let Some(hub) = hub(app) else { return };
    let Some(session) = state.sessions.get(&id) else {
        return;
    };
    hub.publish(
        "permissions",
        Some(id),
        origin,
        json!({
            "state": turn_state_name(session.transcript.state),
            "pending": pending_list(&session.transcript),
        }),
    );
}

/// A decision prompt was answered.
pub fn decision(app: &AppHandle, id: u64, decision_id: &str, response: &Value, origin: &Origin) {
    let Some(hub) = hub(app) else { return };
    hub.publish(
        "decision",
        Some(id),
        origin,
        json!({ "decisionId": decision_id, "response": response }),
    );
}

/// Someone pressed Stop. The turn's end still arrives as a harness event; this
/// only lets the other clients know it was on purpose.
pub fn interrupted(app: &AppHandle, id: u64, origin: &Origin) {
    let Some(hub) = hub(app) else { return };
    hub.publish("interrupted", Some(id), origin, json!({}));
}

/// Clients holding this transcript should fetch it again.
pub fn transcript_reset(app: &AppHandle, id: u64, origin: &Origin) {
    let Some(hub) = hub(app) else { return };
    hub.publish("transcript_reset", Some(id), origin, json!({}));
}

/// Re-sends a session's list row if anything a list shows about it changed —
/// title, state, pending prompts, model, mode, branch. Cheap to call after
/// every change: an unchanged row costs a hash and publishes nothing.
pub fn session_touched(app: &AppHandle, state: &AppState, id: u64, origin: &Origin) {
    let Some(hub) = hub(app) else { return };
    let Some(row) = crate::mobile::dto::session_row(state, id) else {
        return;
    };
    let Ok(mut value) = serde_json::to_value(&row) else {
        return;
    };
    // Activity moves with every token; it must not make every token a row.
    value["lastActivityMs"] = Value::from(0);
    let mut hasher = DefaultHasher::new();
    value.to_string().hash(&mut hasher);
    if !hub.row_changed(id, hasher.finish()) {
        return;
    }
    value["lastActivityMs"] = Value::from(row.last_activity_ms);
    hub.publish("session", Some(id), origin, value);
}

/// A session was closed.
pub fn session_removed(app: &AppHandle, id: u64, origin: &Origin) {
    let Some(hub) = hub(app) else { return };
    hub.forget_row(id);
    hub.publish("session_removed", Some(id), origin, json!({}));
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(envelope: &Envelope) -> Value {
        serde_json::from_str(&envelope.json).expect("frames are JSON")
    }

    #[test]
    fn envelopes_are_numbered_in_order() {
        let hub = SyncHub::new();
        assert_eq!(hub.seq(), 0);
        let a = hub.publish("interrupted", Some(1), &Origin::Desktop, json!({}));
        let b = hub.publish("interrupted", Some(2), &Origin::Agent, json!({}));
        assert_eq!((a, b), (1, 2));
        assert_eq!(hub.seq(), 2);
    }

    #[test]
    fn a_frame_names_its_origin_so_clients_can_skip_their_own() {
        let hub = SyncHub::new();
        hub.publish(
            "user_message",
            Some(4),
            &Origin::Client("abc".into()),
            json!({"text": "hi"}),
        );
        hub.publish(
            "user_message",
            Some(4),
            &Origin::Desktop,
            json!({"text": "yo"}),
        );
        let sub = hub.subscribe(Some(0), None);
        let frames: Vec<Value> = sub.replay.iter().map(|e| frame(e)).collect();
        assert_eq!(frames[0]["origin"], "client:abc");
        assert_eq!(frames[0]["sessionId"], 4);
        assert_eq!(frames[0]["payload"]["text"], "hi");
        assert_eq!(frames[1]["origin"], "desktop");
    }

    #[test]
    fn a_reconnect_replays_exactly_what_it_missed() {
        let hub = SyncHub::new();
        for _ in 0..5 {
            hub.publish("interrupted", Some(1), &Origin::Agent, json!({}));
        }
        let sub = hub.subscribe(Some(3), Some(hub.epoch()));
        assert!(!sub.resync);
        let seqs: Vec<u64> = sub.replay.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![4, 5]);
    }

    #[test]
    fn a_caught_up_client_replays_nothing_and_gets_the_next_one_live() {
        let hub = SyncHub::new();
        hub.publish("interrupted", Some(1), &Origin::Agent, json!({}));
        let mut sub = hub.subscribe(Some(1), None);
        assert!(sub.replay.is_empty() && !sub.resync);
        hub.publish("interrupted", Some(1), &Origin::Agent, json!({}));
        let live = sub.rx.try_recv().expect("the new envelope arrives live");
        assert_eq!(live.seq, 2);
    }

    #[test]
    fn a_position_from_another_run_or_past_the_ring_asks_for_a_resync() {
        let hub = SyncHub::new();
        for _ in 0..3 {
            hub.publish("interrupted", Some(1), &Origin::Agent, json!({}));
        }
        // Another run's epoch: its numbers mean nothing here.
        assert!(hub.subscribe(Some(1), Some("not-this-run")).resync);
        // A number this run never reached (the app restarted under the phone).
        assert!(hub.subscribe(Some(99), None).resync);
        // Older than anything the ring still holds: after this many more,
        // envelopes 1..=3 have been dropped.
        for _ in 0..RING_CAPACITY {
            hub.publish("interrupted", Some(1), &Origin::Agent, json!({}));
        }
        assert!(hub.subscribe(Some(1), Some(hub.epoch())).resync);
        // A client that saw 3 missed only what the ring still has.
        let sub = hub.subscribe(Some(3), None);
        assert!(!sub.resync);
        assert_eq!(sub.replay.first().map(|e| e.seq), Some(4));
    }

    #[test]
    fn big_tool_output_is_capped_on_a_character_boundary() {
        let text = "é".repeat(STREAM_OUTPUT_LIMIT); // two bytes each
        let mut payload =
            json!({"type": "tool_result", "id": "t1", "output": text, "is_error": false});
        cap_tool_output(&mut payload);
        let capped = payload["output"].as_str().unwrap();
        assert!(capped.len() <= STREAM_OUTPUT_LIMIT);
        assert!(capped.chars().all(|c| c == 'é'));
        assert_eq!(payload["bytes"], STREAM_OUTPUT_LIMIT * 2);

        let mut small =
            json!({"type": "tool_result", "id": "t1", "output": "ok", "is_error": false});
        cap_tool_output(&mut small);
        assert!(small.get("bytes").is_none());
    }

    #[test]
    fn revocation_is_a_signal_not_an_envelope() {
        let hub = SyncHub::new();
        let mut sub = hub.subscribe(None, None);
        hub.revoke_device("dev1");
        let signal = sub.rx.try_recv().unwrap();
        assert_eq!(signal.revoked_device.as_deref(), Some("dev1"));
        // Nothing to replay, and the sequence didn't move.
        assert_eq!(hub.seq(), 0);
        assert!(hub.subscribe(Some(0), None).replay.is_empty());
    }
}

//! Context distillation for session handover.
//!
//! When starting a new session and passing context from a previous one,
//! this module synthesizes a concise, high-density Markdown context file
//! (`context.md`) using the model/agent that was used in that previous session.
//! If the agent CLI is unavailable, it uses a deterministic fallback distillation
//! so the operation never fails.

use crate::agents::{prepare_program_args, resolve_executable, AgentId};
use crate::transcript::{Transcript, TranscriptEntry};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(45);

const CONTEXT_SYSTEM_PROMPT: &str = r#"You are an expert AI software engineer synthesizing a structured handover context file in Markdown (`context.md`) from a previous coding session.
Your task is to summarize the session into a concise, high-density handover file that will be injected into a NEW chat session.
Do NOT reproduce entire conversation logs, conversational filler, or verbose tool outputs. Focus on extracting the essential state, decisions, files, and next actions.

Output strictly valid Markdown in the following format:

# Context Handover: <Session Title>

## 🎯 Goal & Problem Statement
Concise 1-3 sentences stating what the user wanted to achieve and the initial problem.

## 🔑 Key Decisions & Architecture
Bullet points describing critical design choices, dependencies introduced, patterns chosen, or trade-offs made.

## 📁 Files Touched & Key Modifications
List the key files modified, created, or analyzed, with 1 bullet per file explaining what changed or was discovered.

## ⚡ Current Status & Pending Tasks
What was accomplished, what is currently working, and any unfinished items or next steps for the new session.

## ⚠️ Notes, Warnings & Caveats
Any test results, errors encountered, edge cases, or environment details the new session must be aware of."#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionContextSummary {
    pub session_id: u64,
    pub title: String,
    pub agent: String,
    pub model: Option<String>,
    pub markdown: String,
    pub file_path: Option<String>,
}

/// Generates a structured Markdown context handover for a session.
pub fn generate_context_summary(
    session_id: u64,
    title: &str,
    agent: AgentId,
    model: Option<&str>,
    transcript: &Transcript,
    cwd: &Path,
) -> SessionContextSummary {
    let condensed = extract_condensed_transcript(&transcript.entries, 12_000);
    let prompt = format!(
        "Session Title: {title}\n\nTranscript History:\n{condensed}\n\nPlease generate the markdown handover context file now according to the system prompt."
    );

    let candidates = match agent {
        AgentId::Claude => [AgentId::Claude, AgentId::Codex],
        AgentId::Codex => [AgentId::Codex, AgentId::Claude],
        AgentId::Antigravity => [AgentId::Antigravity, AgentId::Claude],
        AgentId::Opencode => [AgentId::Opencode, AgentId::Claude],
        _ => [AgentId::Claude, AgentId::Codex],
    };

    let mut generated_markdown: Option<String> = None;

    for candidate in candidates {
        if let Some(program) = resolve_executable(candidate.descriptor()) {
            let scratch =
                std::env::temp_dir().join(format!("egant-context-{}", uuid::Uuid::new_v4()));
            if std::fs::create_dir_all(&scratch).is_err() {
                continue;
            }

            let res = match candidate {
                AgentId::Claude => summarize_with_claude(&program, &scratch, model, &prompt),
                AgentId::Codex => summarize_with_codex(&program, &scratch, model, &prompt),
                AgentId::Antigravity => {
                    summarize_with_antigravity(&program, &scratch, model, &prompt)
                }
                AgentId::Opencode => summarize_with_opencode(&program, &scratch, model, &prompt),
                _ => None,
            };

            let _ = std::fs::remove_dir_all(&scratch);

            if let Some(text) = res {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    generated_markdown = Some(trimmed.to_string());
                    break;
                }
            }
        }
    }

    let markdown = generated_markdown.unwrap_or_else(|| {
        log::info!("using fallback context synthesizer for session {title}");
        fallback_summary(title, &transcript.entries, agent.as_str(), model)
    });

    let file_path = write_context_file(cwd, session_id, title, &markdown);

    SessionContextSummary {
        session_id,
        title: title.to_string(),
        agent: agent.as_str().to_string(),
        model: model.map(|s| s.to_string()),
        markdown,
        file_path,
    }
}

pub fn extract_condensed_transcript(entries: &[TranscriptEntry], max_chars: usize) -> String {
    let mut parts = Vec::new();
    for entry in entries {
        match entry {
            TranscriptEntry::User { text, .. } => {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    let user_snippet: String = trimmed.chars().take(1000).collect();
                    parts.push(format!("User: {user_snippet}"));
                }
            }
            TranscriptEntry::Assistant { text, .. } => {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    let assist_snippet: String = trimmed.chars().take(1200).collect();
                    parts.push(format!("Assistant: {assist_snippet}"));
                }
            }
            TranscriptEntry::Tool(call) => {
                let status = if call.is_error { "FAILED" } else { "OK" };
                let input_str = serde_json::to_string(&call.input).unwrap_or_default();
                let input_summary: String = input_str.chars().take(150).collect();
                parts.push(format!("Tool {} [{status}]: {input_summary}", call.name));
            }
            TranscriptEntry::Notice { text, is_error } => {
                if *is_error {
                    parts.push(format!("Notice (Error): {text}"));
                }
            }
            _ => {}
        }
    }

    let full = parts.join("\n\n");
    if full.len() > max_chars {
        let half = max_chars / 2;
        let start: String = full.chars().take(half).collect();
        let end: String = full
            .chars()
            .skip(full.chars().count().saturating_sub(half))
            .collect();
        format!("{start}\n\n... [transcript condensed for summarizer] ...\n\n{end}")
    } else {
        full
    }
}

pub fn fallback_summary(
    title: &str,
    entries: &[TranscriptEntry],
    agent: &str,
    model: Option<&str>,
) -> String {
    let mut user_goals = Vec::new();
    let mut files_touched = std::collections::BTreeSet::new();
    let mut errors = Vec::new();
    let mut last_assistant = String::new();

    for entry in entries {
        match entry {
            TranscriptEntry::User { text, .. } => {
                let first_line = text.lines().next().unwrap_or("").trim();
                if !first_line.is_empty() && user_goals.len() < 5 {
                    user_goals.push(first_line.to_string());
                }
            }
            TranscriptEntry::Assistant { text, .. } => {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    last_assistant = trimmed.to_string();
                }
            }
            TranscriptEntry::Tool(call) => {
                if let Some(obj) = call.input.as_object() {
                    if let Some(p) = obj
                        .get("path")
                        .or_else(|| obj.get("file"))
                        .or_else(|| obj.get("filePath"))
                    {
                        if let Some(s) = p.as_str() {
                            files_touched.insert(s.to_string());
                        }
                    }
                }
                if call.is_error {
                    errors.push(format!("Tool `{}` encountered an error", call.name));
                }
            }
            TranscriptEntry::Notice { text, is_error } if *is_error => {
                errors.push(text.clone());
            }
            _ => {}
        }
    }

    let mut out = format!("# Context Handover: {title}\n\n");
    out.push_str("## 🎯 Goal & Problem Statement\n");
    if !user_goals.is_empty() {
        for goal in &user_goals {
            out.push_str(&format!("- {goal}\n"));
        }
    } else {
        out.push_str(&format!("- Work on: {title}\n"));
    }
    out.push('\n');

    out.push_str("## 🔑 Key Decisions & Architecture\n");
    out.push_str(&format!("- Previous session managed by agent `{agent}`"));
    if let Some(m) = model {
        out.push_str(&format!(" using model `{m}`"));
    }
    out.push_str(".\n- Session state preserved and handed over to new chat.\n\n");

    out.push_str("## 📁 Files Touched & Key Modifications\n");
    if !files_touched.is_empty() {
        for f in files_touched.iter().take(15) {
            out.push_str(&format!("- `{f}`\n"));
        }
    } else {
        out.push_str("- No explicit file modifications recorded in tool log.\n");
    }
    out.push('\n');

    out.push_str("## ⚡ Current Status & Pending Tasks\n");
    if !last_assistant.is_empty() {
        let snippet: String = last_assistant.chars().take(400).collect();
        out.push_str(&format!("- Last assistant summary: {snippet}\n"));
    } else {
        out.push_str("- Ready for next instructions in new session.\n");
    }
    out.push('\n');

    if !errors.is_empty() {
        out.push_str("## ⚠️ Notes, Warnings & Caveats\n");
        for err in errors.iter().take(5) {
            out.push_str(&format!("- {err}\n"));
        }
        out.push('\n');
    }

    out
}

fn summarize_with_claude(
    program: &Path,
    scratch: &Path,
    model: Option<&str>,
    prompt: &str,
) -> Option<String> {
    let (prog, prefix) = prepare_program_args(program);
    let mut command = Command::new(prog);
    command.args(prefix);
    command.args([
        "-p",
        "--output-format",
        "text",
        "--no-session-persistence",
        "--system-prompt",
        CONTEXT_SYSTEM_PROMPT,
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        r#"{"mcpServers":{}}"#,
        "--setting-sources",
        "",
    ]);
    if let Some(m) = model {
        command.args(["--model", m]);
    } else {
        command.args(["--model", "haiku"]);
    }
    let (status, stdout) = run(command, scratch, prompt)?;
    if !status.success() {
        log::warn!("claude context summarization exited {status}");
        return None;
    }
    Some(stdout)
}

fn summarize_with_codex(
    program: &Path,
    scratch: &Path,
    model: Option<&str>,
    prompt: &str,
) -> Option<String> {
    let last_message = scratch.join("context.md");
    let (prog, prefix) = prepare_program_args(program);
    let mut command = Command::new(prog);
    command.args(prefix);
    command.args([
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "-c",
        "model_reasoning_effort=low",
    ]);
    if let Some(model) = model {
        command.args(["-m", model]);
    }
    command.arg("-o").arg(&last_message).arg("-");
    let (status, _) = run(
        command,
        scratch,
        &format!("{CONTEXT_SYSTEM_PROMPT}\n\n{prompt}"),
    )?;
    if !status.success() {
        log::warn!("codex context summarization exited {status}");
        return None;
    }
    std::fs::read_to_string(&last_message).ok()
}

fn summarize_with_antigravity(
    program: &Path,
    scratch: &Path,
    model: Option<&str>,
    prompt: &str,
) -> Option<String> {
    let (prog, prefix) = prepare_program_args(program);
    let mut command = Command::new(prog);
    command.args(prefix);
    command.args(["--output-format", "stream-json", "--mode", "accept-edits"]);
    if let Some(model) = model {
        command.args(["--model", model]);
    }
    let full_prompt = format!("{CONTEXT_SYSTEM_PROMPT}\n\n{prompt}");
    command.arg(format!("--print={full_prompt}"));
    let (status, stdout) = run_no_stdin(command, scratch)?;
    if !status.success() {
        log::warn!("antigravity context summarization exited {status}");
        return None;
    }

    // Parse JSON stream lines
    let mut response_acc = String::new();
    for line in stdout.lines() {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(result) = val.get("result") {
                if let Some(resp) = result.get("response").and_then(|r| r.as_str()) {
                    return Some(resp.to_string());
                }
            }
            if let Some(step) = val.get("step_update") {
                if step.get("step_type").and_then(|s| s.as_str()) == Some("agent_response") {
                    if let Some(delta) = step.get("text_delta").and_then(|d| d.as_str()) {
                        response_acc.push_str(delta);
                    }
                }
            }
        }
    }

    if !response_acc.trim().is_empty() {
        Some(response_acc)
    } else {
        None
    }
}

fn summarize_with_opencode(
    program: &Path,
    scratch: &Path,
    model: Option<&str>,
    prompt: &str,
) -> Option<String> {
    let (prog, prefix) = prepare_program_args(program);
    let mut command = Command::new(prog);
    command.args(prefix);
    command.args(["run", "--format", "json"]);
    if let Some(model) = model {
        command.args(["-m", model]);
    }
    let full_prompt = format!("{CONTEXT_SYSTEM_PROMPT}\n\n{prompt}");
    command.arg(&full_prompt);
    let (status, stdout) = run_no_stdin(command, scratch)?;
    if !status.success() {
        log::warn!("opencode context summarization exited {status}");
        return None;
    }

    let mut response_acc = String::new();
    for line in stdout.lines() {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
            if val.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(part) = val.get("part") {
                    if let Some(txt) = part.get("text").and_then(|t| t.as_str()) {
                        response_acc.push_str(txt);
                    }
                }
            }
        }
    }

    if !response_acc.trim().is_empty() {
        Some(response_acc)
    } else {
        None
    }
}

fn run(mut command: Command, cwd: &Path, input: &str) -> Option<(ExitStatus, String)> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| log::warn!("context CLI failed to start: {error}"))
        .ok()?;
    let wrote = child
        .stdin
        .take()
        .is_some_and(|mut stdin| stdin.write_all(input.as_bytes()).is_ok());
    let Some(mut stdout) = child.stdout.take().filter(|_| wrote) else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        let _ = tx.send(out);
    });

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() > TIMEOUT => {
                log::warn!("context CLI timed out after {}s", TIMEOUT.as_secs());
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    };
    let stdout = rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    Some((status, String::from_utf8_lossy(&stdout).into_owned()))
}

fn run_no_stdin(mut command: Command, cwd: &Path) -> Option<(ExitStatus, String)> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| log::warn!("context CLI failed to start: {error}"))
        .ok()?;
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        let _ = tx.send(out);
    });

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() > TIMEOUT => {
                log::warn!("context CLI timed out after {}s", TIMEOUT.as_secs());
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    };
    let stdout = rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    Some((status, String::from_utf8_lossy(&stdout).into_owned()))
}

fn write_context_file(
    cwd: &Path,
    session_id: u64,
    title: &str,
    content: &str,
) -> Option<String> {
    let safe_title: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(30)
        .collect();
    let file_name = format!("context-{session_id}-{safe_title}.md");

    let target = cwd.join(".egant").join("contexts").join(&file_name);
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::write(&target, content).is_ok() {
        return Some(target.to_string_lossy().to_string());
    }

    let temp_target = std::env::temp_dir()
        .join("egant")
        .join("contexts")
        .join(&file_name);
    if let Some(parent) = temp_target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::write(&temp_target, content).is_ok() {
        return Some(temp_target.to_string_lossy().to_string());
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::ToolCall;

    #[test]
    fn test_fallback_summary_extracts_goals_and_files() {
        let entries = vec![
            TranscriptEntry::User {
                text: "Please refactor the auth system to use JWT tokens".to_string(),
                images: vec![],
            },
            TranscriptEntry::Tool(ToolCall {
                id: "call-1".to_string(),
                name: "write_file".to_string(),
                input: serde_json::json!({
                    "path": "src/auth/jwt.rs",
                    "content": "pub fn verify() {}"
                }),
                output: Some("written".to_string()),
                is_error: false,
                children: vec![],
            }),
            TranscriptEntry::Assistant {
                text: "I have refactored the auth module to use JWT tokens.".to_string(),
                streaming: false,
            },
        ];

        let summary = fallback_summary("Refactor Auth", &entries, "claude", Some("haiku"));
        assert!(summary.contains("# Context Handover: Refactor Auth"));
        assert!(summary.contains("Please refactor the auth system"));
        assert!(summary.contains("`src/auth/jwt.rs`"));
        assert!(summary.contains("`claude`"));
        assert!(summary.contains("`haiku`"));
    }

    #[test]
    fn test_extract_condensed_transcript() {
        let entries = vec![
            TranscriptEntry::User {
                text: "Hello world".to_string(),
                images: vec![],
            },
            TranscriptEntry::Assistant {
                text: "Hi there!".to_string(),
                streaming: false,
            },
        ];

        let condensed = extract_condensed_transcript(&entries, 1000);
        assert!(condensed.contains("User: Hello world"));
        assert!(condensed.contains("Assistant: Hi there!"));
    }
}

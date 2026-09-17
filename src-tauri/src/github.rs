//! GitHub, by way of the user's own `gh`.
//!
//! Same reasoning as `egant_vcs::remote`: the credentials already exist
//! somewhere only the official client knows how to reach — a keyring entry, a
//! token in `~/.config/gh/hosts.yml`, an enterprise host. Shelling out to `gh`
//! inherits all of it, and inherits the user's choice of account with it,
//! rather than building a second sign-in for them to keep in sync.
//!
//! The cost is that everything here is JSON text parsed leniently: `gh`'s
//! fields differ between versions, so a missing one reads as empty rather than
//! failing the whole call.

use std::path::Path;
use std::process::Command;

use serde::Serialize;
use serde_json::Value;

/// Fields for the list. Deliberately modest — every extra field is another
/// GraphQL join on GitHub's side, and the list is the cheap call.
const LIST_FIELDS: &str = "number,title,state,isDraft,headRefName,baseRefName,url,author,updatedAt,additions,deletions,changedFiles";

/// Everything one expanded pull request shows.
const VIEW_FIELDS: &str = "number,title,state,isDraft,headRefName,baseRefName,url,author,updatedAt,additions,deletions,changedFiles,body,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,commits,files,comments";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatusDto {
    pub installed: bool,
    /// `gh` is installed *and* logged in to a host. Both have to be true
    /// before any of the other calls can work.
    pub authenticated: bool,
    /// What to tell the user when one of the above is false.
    pub hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDto {
    pub number: u64,
    pub title: String,
    /// `OPEN` | `CLOSED` | `MERGED`.
    pub state: String,
    pub draft: bool,
    pub head: String,
    pub base: String,
    pub url: String,
    pub author: String,
    pub updated: String,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
}

/// One CI check. `bucket` is the four-way answer the UI colours by, since
/// GitHub reports checks and legacy statuses in two different shapes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckDto {
    pub name: String,
    /// `pass` | `fail` | `pending` | `skipped`.
    pub bucket: String,
    pub description: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCommitDto {
    pub sha: String,
    pub message: String,
    pub author: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFileDto {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCommentDto {
    pub author: String,
    pub body: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetailDto {
    pub pull_request: PullRequestDto,
    pub body: String,
    /// `MERGEABLE` | `CONFLICTING` | `UNKNOWN`.
    pub mergeable: String,
    /// `APPROVED` | `CHANGES_REQUESTED` | `REVIEW_REQUIRED` | empty.
    pub review_decision: String,
    pub checks: Vec<CheckDto>,
    pub commits: Vec<PrCommitDto>,
    pub files: Vec<PrFileDto>,
    pub comments: Vec<PrCommentDto>,
}

/// Runs `gh` in `root` and hands back stdout, turning both "not installed"
/// and a non-zero exit into a message the panel can show as it is.
fn gh(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("gh")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "GitHub CLI (gh) is not installed".to_string()
            } else {
                format!("could not run gh: {error}")
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if stderr.is_empty() { stdout } else { stderr };
        log::warn!("gh {} failed: {}", args.join(" "), message);
        return Err(message);
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Whether `gh` is there and logged in. Called before the panel offers
/// anything GitHub-shaped, so the section can explain itself instead of
/// failing on the first click.
#[tauri::command]
pub async fn gh_status() -> Result<GhStatusDto, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let installed = Command::new("gh")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
        if !installed {
            return GhStatusDto {
                installed: false,
                authenticated: false,
                hint: "Install the GitHub CLI to see pull requests (`brew install gh`)".into(),
            };
        }

        // `gh auth status` exits non-zero when no host is logged in, which is
        // the whole question being asked here.
        let authenticated = Command::new("gh")
            .args(["auth", "status"])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);

        GhStatusDto {
            installed: true,
            authenticated,
            hint: if authenticated {
                String::new()
            } else {
                "Sign in to GitHub to see pull requests (`gh auth login`)".into()
            },
        }
    })
    .await
    .map_err(|error| error.to_string())
}

/// Open pull requests for the repository `root` belongs to.
#[tauri::command]
pub async fn pr_list(root: String) -> Result<Vec<PullRequestDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stdout = gh(
            Path::new(&root),
            &["pr", "list", "--state", "open", "--limit", "30", "--json", LIST_FIELDS],
        )?;
        let parsed: Value = serde_json::from_str(&stdout).map_err(|error| error.to_string())?;
        Ok(parsed
            .as_array()
            .map(|rows| rows.iter().map(pull_request).collect())
            .unwrap_or_default())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Everything one pull request shows when it is expanded: checks, commits,
/// files and comments, in a single round trip.
#[tauri::command]
pub async fn pr_detail(root: String, number: u64) -> Result<PrDetailDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stdout = gh(
            Path::new(&root),
            &["pr", "view", &number.to_string(), "--json", VIEW_FIELDS],
        )?;
        let parsed: Value = serde_json::from_str(&stdout).map_err(|error| error.to_string())?;

        Ok(PrDetailDto {
            pull_request: pull_request(&parsed),
            body: text(&parsed, "body"),
            mergeable: text(&parsed, "mergeable"),
            review_decision: text(&parsed, "reviewDecision"),
            checks: array(&parsed, "statusCheckRollup").iter().map(check).collect(),
            commits: array(&parsed, "commits")
                .iter()
                .map(|commit| PrCommitDto {
                    sha: text(commit, "oid").chars().take(7).collect(),
                    message: text(commit, "messageHeadline"),
                    author: array(commit, "authors")
                        .first()
                        .map(|author| {
                            let login = text(author, "login");
                            if login.is_empty() { text(author, "name") } else { login }
                        })
                        .unwrap_or_default(),
                })
                .collect(),
            files: array(&parsed, "files")
                .iter()
                .map(|file| PrFileDto {
                    path: text(file, "path"),
                    additions: number_at(file, "additions"),
                    deletions: number_at(file, "deletions"),
                })
                .collect(),
            comments: array(&parsed, "comments")
                .iter()
                .map(|comment| PrCommentDto {
                    author: comment
                        .get("author")
                        .map(|author| text(author, "login"))
                        .unwrap_or_default(),
                    body: text(comment, "body"),
                    at: text(comment, "createdAt"),
                })
                .collect(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Opens a pull request for the current branch. Returns its URL.
#[tauri::command]
pub async fn pr_create(
    root: String,
    title: String,
    body: String,
    draft: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec![
            "pr".to_string(),
            "create".to_string(),
            "--title".to_string(),
            title,
            "--body".to_string(),
            body,
        ];
        if draft {
            args.push("--draft".to_string());
        }
        // `gh pr create` pushes the branch itself when it has no upstream,
        // which is exactly what opening a PR from an unpublished branch needs.
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        Ok(gh(Path::new(&root), &refs)?.trim().to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Merges a pull request. `method` is `squash`, `merge` or `rebase`.
#[tauri::command]
pub async fn pr_merge(root: String, number: u64, method: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let flag = match method.as_str() {
            "merge" => "--merge",
            "rebase" => "--rebase",
            _ => "--squash",
        };
        let output = gh(
            Path::new(&root),
            &["pr", "merge", &number.to_string(), flag],
        )?;
        Ok(output.trim().to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Hands a URL to the platform's browser. The panel links out for everything
/// it deliberately doesn't rebuild — the conversation on a PR, the log of a
/// failed check.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    // Only ever a link the panel itself built from `gh` output, but a shell
    // would still be the wrong thing to hand it to.
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("refusing to open a non-web URL".into());
    }
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", ""]);
        command
    };
    command
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Lenient readers: `gh`'s JSON shape moves between versions, and a field this
// window doesn't get is a field it does without.
// ---------------------------------------------------------------------------

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn number_at(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn pull_request(value: &Value) -> PullRequestDto {
    PullRequestDto {
        number: number_at(value, "number"),
        title: text(value, "title"),
        state: text(value, "state"),
        draft: value.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        head: text(value, "headRefName"),
        base: text(value, "baseRefName"),
        url: text(value, "url"),
        author: value
            .get("author")
            .map(|author| text(author, "login"))
            .unwrap_or_default(),
        updated: text(value, "updatedAt"),
        additions: number_at(value, "additions"),
        deletions: number_at(value, "deletions"),
        changed_files: number_at(value, "changedFiles"),
    }
}

/// GitHub reports a modern check run and a legacy commit status in two
/// different shapes; the panel only cares which of four buckets it lands in.
fn check(value: &Value) -> CheckDto {
    let is_check_run = value.get("name").is_some();
    let name = if is_check_run {
        let workflow = text(value, "workflowName");
        let name = text(value, "name");
        if workflow.is_empty() { name } else { format!("{workflow} / {name}") }
    } else {
        text(value, "context")
    };

    let bucket = if is_check_run {
        match text(value, "status").as_str() {
            "COMPLETED" => match text(value, "conclusion").as_str() {
                "SUCCESS" => "pass",
                "SKIPPED" | "NEUTRAL" => "skipped",
                "" => "pending",
                _ => "fail",
            },
            "" => "pending",
            _ => "pending",
        }
    } else {
        match text(value, "state").as_str() {
            "SUCCESS" => "pass",
            "PENDING" | "EXPECTED" | "" => "pending",
            _ => "fail",
        }
    };

    let url = {
        let details = text(value, "detailsUrl");
        let target = text(value, "targetUrl");
        let link = if details.is_empty() { target } else { details };
        if link.is_empty() { None } else { Some(link) }
    };

    CheckDto {
        name,
        bucket: bucket.to_string(),
        description: text(value, "description"),
        url,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_completed_check_run_reads_its_conclusion() {
        let value: Value = serde_json::from_str(
            r#"{"name":"test","workflowName":"CI","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://example.com/1"}"#,
        )
        .unwrap();
        let check = check(&value);
        assert_eq!(check.name, "CI / test");
        assert_eq!(check.bucket, "fail");
        assert_eq!(check.url.as_deref(), Some("https://example.com/1"));
    }

    #[test]
    fn a_running_check_run_is_pending_whatever_else_it_says() {
        let value: Value =
            serde_json::from_str(r#"{"name":"build","status":"IN_PROGRESS","conclusion":""}"#)
                .unwrap();
        assert_eq!(check(&value).bucket, "pending");
    }

    #[test]
    fn a_legacy_status_context_reads_its_state() {
        let value: Value = serde_json::from_str(
            r#"{"context":"ci/circleci","state":"SUCCESS","targetUrl":"https://example.com/2"}"#,
        )
        .unwrap();
        let check = check(&value);
        assert_eq!(check.name, "ci/circleci");
        assert_eq!(check.bucket, "pass");
        assert_eq!(check.url.as_deref(), Some("https://example.com/2"));
    }

    #[test]
    fn a_pull_request_survives_fields_this_gh_did_not_send() {
        let value: Value = serde_json::from_str(r#"{"number":7,"title":"Fix it"}"#).unwrap();
        let pr = pull_request(&value);
        assert_eq!(pr.number, 7);
        assert_eq!(pr.title, "Fix it");
        assert_eq!(pr.author, "");
        assert_eq!(pr.additions, 0);
        assert!(!pr.draft);
    }

    #[test]
    fn only_web_urls_are_opened() {
        assert!(open_url("file:///etc/passwd".into()).is_err());
        assert!(open_url("javascript:alert(1)".into()).is_err());
    }
}

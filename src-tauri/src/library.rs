//! The Library page's commands: MCP servers and agent skills. The work is in
//! `egant_harness::library`; these only move it off the command thread —
//! every one of them touches the filesystem, the network or a CLI, and
//! listing alone resolves agent binaries, which can fall through to the
//! login-shell `PATH` snapshot.

use egant_harness::library::mcp::{self, McpLibrary, McpServer};
use egant_harness::library::mcp_catalog::{self, McpCatalog};
use egant_harness::library::skills::{
    self, CatalogSkill, FeaturedSource, SkillCommandOutcome, SkillsLibrary,
};

async fn blocking<T: Send + 'static>(
    label: &'static str,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| {
            log::warn!("{label} failed: {error}");
            error
        })
}

#[tauri::command]
pub async fn library_mcp() -> Result<McpLibrary, String> {
    blocking("library_mcp", mcp::library).await
}

/// emdash's catalog, live from GitHub (cached for hours), or the copy built
/// into egant when that can't be had.
#[tauri::command]
pub async fn library_mcp_catalog(refresh: bool) -> Result<McpCatalog, String> {
    blocking("library_mcp_catalog", move || {
        Ok(mcp_catalog::load(refresh))
    })
    .await
}

#[tauri::command]
pub async fn library_mcp_save(
    server: McpServer,
    agents: Vec<String>,
    previous_name: Option<String>,
) -> Result<McpLibrary, String> {
    log::info!("library_mcp_save {} -> {agents:?}", server.name);
    blocking("library_mcp_save", move || {
        mcp::save(server, &agents, previous_name.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn library_mcp_remove(name: String) -> Result<McpLibrary, String> {
    log::info!("library_mcp_remove {name}");
    blocking("library_mcp_remove", move || mcp::remove(&name)).await
}

#[tauri::command]
pub async fn library_skills() -> Result<SkillsLibrary, String> {
    blocking("library_skills", skills::library).await
}

#[tauri::command]
pub async fn library_skills_search(query: String) -> Result<Vec<CatalogSkill>, String> {
    blocking("library_skills_search", move || skills::search(&query)).await
}

#[tauri::command]
pub async fn library_skills_featured(refresh: bool) -> Result<Vec<FeaturedSource>, String> {
    blocking("library_skills_featured", move || skills::featured(refresh)).await
}

#[tauri::command]
pub async fn library_skills_popular(refresh: bool) -> Result<Vec<CatalogSkill>, String> {
    blocking("library_skills_popular", move || skills::popular(refresh)).await
}

#[tauri::command]
pub async fn library_skills_check_updates(refresh: bool) -> Result<Vec<String>, String> {
    blocking("library_skills_check_updates", move || {
        skills::check_updates(refresh)
    })
    .await
}

/// Empty `names` updates every skill the skills CLI installed.
#[tauri::command]
pub async fn library_skills_update(names: Vec<String>) -> Result<SkillCommandOutcome, String> {
    log::info!("library_skills_update {names:?}");
    blocking("library_skills_update", move || skills::update(&names)).await
}

#[tauri::command]
pub async fn library_skill_read_installed(id: String) -> Result<String, String> {
    blocking("library_skill_read_installed", move || {
        skills::read_installed(&id)
    })
    .await
}

#[tauri::command]
pub async fn library_skill_read_remote(
    source: String,
    skill_id: String,
    path: Option<String>,
) -> Result<String, String> {
    blocking("library_skill_read_remote", move || {
        skills::read_remote(&source, &skill_id, path.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn library_skill_install(
    source: String,
    skill: String,
    agents: Vec<String>,
) -> Result<SkillCommandOutcome, String> {
    log::info!("library_skill_install {source} {skill} -> {agents:?}");
    blocking("library_skill_install", move || {
        skills::install(&source, &skill, &agents)
    })
    .await
}

#[tauri::command]
pub async fn library_skill_uninstall(id: String) -> Result<SkillCommandOutcome, String> {
    log::info!("library_skill_uninstall {id}");
    blocking("library_skill_uninstall", move || skills::uninstall(&id)).await
}

#[tauri::command]
pub async fn library_skill_set_agents(
    id: String,
    agents: Vec<String>,
) -> Result<SkillsLibrary, String> {
    log::info!("library_skill_set_agents {id} -> {agents:?}");
    blocking("library_skill_set_agents", move || {
        skills::set_agents(&id, &agents)
    })
    .await
}

#[tauri::command]
pub async fn library_skill_create(
    name: String,
    description: String,
    body: String,
    agents: Vec<String>,
) -> Result<SkillsLibrary, String> {
    log::info!("library_skill_create {name} -> {agents:?}");
    blocking("library_skill_create", move || {
        skills::create(&name, &description, &body, &agents)
    })
    .await
}

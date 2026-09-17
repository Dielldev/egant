fn main() {
    // `tauri::generate_context!()` bakes the bundle icons straight into the
    // binary, but `tauri_build` only asks cargo to watch `tauri.conf.json`.
    // Without this the artwork can change and cargo still sees nothing to do,
    // so the dock keeps serving the icon compiled into the last build through
    // any number of restarts.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}

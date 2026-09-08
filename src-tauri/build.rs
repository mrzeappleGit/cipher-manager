fn main() {
    // Fresh-clone debug checks do not require a prebuilt release sidecar.
    // Release builds must stage it through prepare-bundle.mjs first.
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        let mut config: serde_json::Value =
            serde_json::from_str(&std::env::var("TAURI_CONFIG").unwrap_or_else(|_| "{}".into()))
                .expect("valid TAURI_CONFIG");
        config["bundle"]["externalBin"] = serde_json::json!([]);
        std::env::set_var("TAURI_CONFIG", config.to_string());
    }
    // Embed the single-file snapshot build if present; stub otherwise so a fresh
    // clone still cargo-checks. Real builds run `npm run build:snapshot` first.
    let out =
        std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("snapshot-template.html");
    let src = std::path::Path::new("../dist-snapshot/index.html");
    println!("cargo:rerun-if-changed=../dist-snapshot/index.html");
    if src.exists() {
        std::fs::copy(src, &out).expect("copy snapshot template");
    } else {
        // </head> gives bake_html its fallback injection anchor on stub builds.
        // "snapshot template missing" must stay in sync with STUB_MARKER in
        // src/snapshot.rs, which refuses to push stub builds to the cloud.
        std::fs::write(&out, "<html><head></head><body>snapshot template missing - run npm run build:snapshot before building</body></html>").expect("write stub");
    }
    tauri_build::build()
}

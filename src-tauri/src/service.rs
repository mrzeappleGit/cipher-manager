//! Explicit lifecycle for the bundled server. Closing the UI never stops it.
use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, TcpStream};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock, RwLockReadGuard};
use std::time::{Duration, Instant};

const ADDRESS: &str = "127.0.0.1:4600";
pub const APPLICATION: &str = "cipher-manager-serve";
pub const PROTOCOL: u32 = 1;
static CONTROL: Mutex<()> = Mutex::new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ok: bool,
    pub application: String,
    pub version: String,
    pub protocol: u32,
    pub instance: String,
}

pub fn health(instance: &str) -> Health {
    Health {
        ok: true,
        application: APPLICATION.into(),
        version: env!("CARGO_PKG_VERSION").into(),
        protocol: PROTOCOL,
        instance: instance.into(),
    }
}

fn known_server(h: &Health) -> bool {
    h.ok && h.application == APPLICATION
        && h.protocol == PROTOCOL
        && !h.version.is_empty()
        && !h.instance.is_empty()
}

/// Read guards span requests, including synchronous work which launches a job.
/// Shutdown takes the exclusive guard before checking for background work.
pub struct Lifecycle {
    gate: RwLock<()>,
    stopping: AtomicBool,
    pub instance: String,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            gate: RwLock::new(()),
            stopping: AtomicBool::new(false),
            instance: format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
        }
    }
}

impl Lifecycle {
    pub fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    pub fn enter(&self) -> Result<RwLockReadGuard<'_, ()>, String> {
        let guard = self
            .gate
            .read()
            .map_err(|_| "Server lifecycle is unavailable")?;
        if self.stopping() {
            return Err("Server is stopping".into());
        }
        Ok(guard)
    }

    pub fn stop(
        &self,
        instance: &str,
        busy: impl FnOnce() -> Result<Option<String>, String>,
    ) -> Result<(), String> {
        if instance != self.instance {
            return Err("Server changed; refresh its status before stopping".into());
        }
        let _guard = self
            .gate
            .try_write()
            .map_err(|_| "Server is handling a request; retry when it finishes")?;
        if let Some(reason) = busy()? {
            return Err(reason);
        }
        self.stopping.store(true, Ordering::SeqCst);
        Ok(())
    }
}

pub fn shutdown_authorized(header: Option<&str>, token: &str) -> bool {
    !token.is_empty() && header.and_then(|h| h.strip_prefix("Bearer ")) == Some(token)
}

pub fn active_work_reason() -> Result<Option<String>, String> {
    if crate::agents::agent_list_impl()
        .iter()
        .any(|s| s.status == "running")
    {
        return Ok(Some(
            "Stop refused: interactive agent sessions are running".into(),
        ));
    }
    if crate::commands::has_running_jobs()? {
        return Ok(Some("Stop refused: jobs are running".into()));
    }
    if crate::recorder::recording_status().recording {
        return Ok(Some("Stop refused: a recording is in progress".into()));
    }
    Ok(None)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub state: &'static str,
    pub version: Option<String>,
    pub version_matches: bool,
    pub message: String,
}

fn client() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(2))
        .redirects(0)
        .build()
}

fn probe(token: &str) -> Result<Option<Health>, String> {
    let addr: SocketAddr = ADDRESS.parse().unwrap();
    match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(stream) => drop(stream),
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => return Ok(None),
        Err(e) => return Err(format!("Cannot check local server: {e}")),
    }
    let response = client()
        .post(&format!("http://{ADDRESS}/api/health"))
        .set("Authorization", &format!("Bearer {token}"))
        .send_string("{}")
        .map_err(|_| "Port 4600 is occupied but did not answer as the bundled server")?;
    let health: Health = response
        .into_json()
        .map_err(|_| "Port 4600 returned an unrecognized health response")?;
    if !known_server(&health) {
        return Err("Port 4600 belongs to an incompatible server; it will not be stopped".into());
    }
    Ok(Some(health))
}

fn status_impl() -> Result<ServerStatus, String> {
    let token = crate::commands::ensure_serve_token()?;
    Ok(match probe(&token) {
        Ok(Some(h)) => ServerStatus {
            state: "running",
            version_matches: h.version == env!("CARGO_PKG_VERSION"),
            version: Some(h.version),
            message: "Running at http://127.0.0.1:4600. Agent sessions survive closing this app."
                .into(),
        },
        Ok(None) => ServerStatus {
            state: "stopped",
            version: None,
            version_matches: true,
            message: "Stopped. Start the server to use interactive agents or the local web app."
                .into(),
        },
        Err(message) => ServerStatus {
            state: "unavailable",
            version: None,
            version_matches: false,
            message,
        },
    })
}

fn server_binary() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let sibling = exe.with_file_name(if cfg!(windows) { "serve.exe" } else { "serve" });
    if sibling.is_file() {
        return Ok(sibling);
    }
    #[cfg(debug_assertions)]
    {
        let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/release")
            .join(if cfg!(windows) { "serve.exe" } else { "serve" });
        if dev.is_file() {
            return Ok(dev);
        }
    }
    Err("Bundled server is missing. Reinstall the app, or run npm run prepare:bundle for development.".into())
}

fn start_impl() -> Result<ServerStatus, String> {
    let _guard = CONTROL
        .lock()
        .map_err(|_| "Server controls are unavailable")?;
    let token = crate::commands::ensure_serve_token()?;
    if let Some(h) = probe(&token)? {
        if h.version != env!("CARGO_PKG_VERSION") {
            return Err("A different server version is running. Finish active work, stop it, then start the bundled version.".into());
        }
        return status_impl();
    }
    let mut cmd = Command::new(server_binary()?);
    cmd.args(["--host", "127.0.0.1", "--port", "4600"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW; no kill-on-drop owner.
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Cannot start bundled server: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Some(exit) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!("Bundled server exited before becoming ready ({exit}); check whether port 4600 is already in use"));
        }
        if let Ok(Some(h)) = probe(&token) {
            if h.version == env!("CARGO_PKG_VERSION") {
                return status_impl();
            }
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err("Server did not become ready within 15 seconds. It may still be starting; refresh status before trying again.".into())
}

fn stop_impl() -> Result<ServerStatus, String> {
    let _guard = CONTROL
        .lock()
        .map_err(|_| "Server controls are unavailable")?;
    if let Some(reason) = active_work_reason()? {
        return Err(reason);
    }
    let token = crate::commands::ensure_serve_token()?;
    let Some(h) = probe(&token)? else {
        return status_impl();
    };
    let result = client()
        .post(&format!("http://{ADDRESS}/api/shutdown"))
        .set("Authorization", &format!("Bearer {token}"))
        .send_json(serde_json::json!({"instance": h.instance}));
    match result {
        Ok(_) => {}
        Err(ureq::Error::Status(_, response)) => {
            let body: serde_json::Value = response.into_json().unwrap_or_default();
            return Err(body
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Server refused to stop")
                .into());
        }
        Err(_) => {
            return Err("Shutdown response was lost. Refresh server status before retrying.".into())
        }
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        match probe(&token) {
            Ok(None) => return status_impl(),
            Ok(Some(next)) if next.instance != h.instance => {
                return Err("Another server started while this one stopped. Refresh status.".into())
            }
            _ => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    Err("Shutdown accepted; server has not exited yet. Refresh status.".into())
}

#[tauri::command]
pub async fn local_server_status() -> Result<ServerStatus, String> {
    tauri::async_runtime::spawn_blocking(status_impl)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn local_server_start() -> Result<ServerStatus, String> {
    tauri::async_runtime::spawn_blocking(start_impl)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn local_server_stop() -> Result<ServerStatus, String> {
    tauri::async_runtime::spawn_blocking(stop_impl)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_auth_and_shutdown_races() {
        let mut h = health("test-instance");
        assert!(known_server(&h));
        h.application = "unrelated-http-server".into();
        assert!(!known_server(&h));
        assert!(!shutdown_authorized(None, "test-token"));
        assert!(!shutdown_authorized(Some("Bearer wrong"), "test-token"));
        assert!(!shutdown_authorized(Some("Bearer "), ""));
        assert!(shutdown_authorized(Some("Bearer test-token"), "test-token"));

        let life = Lifecycle::default();
        let request = life.enter().unwrap();
        assert!(life.stop(&life.instance, || Ok(None)).is_err());
        drop(request);
        assert!(life.stop("previous-instance", || Ok(None)).is_err());
        for reason in ["agents running", "jobs running", "recording"] {
            assert_eq!(
                life.stop(&life.instance, || Ok(Some(reason.into())))
                    .unwrap_err(),
                reason
            );
            assert!(!life.stopping());
        }
        assert!(life
            .stop(&life.instance, || Err("cannot check work".into()))
            .is_err());
        life.stop(&life.instance, || Ok(None)).unwrap();
        assert!(life.stopping());
        assert!(life.enter().is_err());
    }
}

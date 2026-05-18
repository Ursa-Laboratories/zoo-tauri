use std::{
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use tauri::Manager;

const BACKEND_HOST: &str = "127.0.0.1";
const BACKEND_PORT: &str = "8742";
const TARGET_TRIPLE: &str = env!("TARGET_TRIPLE");

#[cfg(windows)]
const EXE_EXTENSION: &str = ".exe";
#[cfg(not(windows))]
const EXE_EXTENSION: &str = "";

struct BackendProcess(Mutex<Option<Child>>);

fn sidecar_name() -> String {
    format!("zoo-backend-{TARGET_TRIPLE}{EXE_EXTENSION}")
}

fn sidecar_candidates(app: &tauri::App) -> Vec<PathBuf> {
    let name = sidecar_name();
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(&name));
        candidates.push(resource_dir.join("binaries").join(&name));
    }

    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        candidates.push(Path::new(&manifest_dir).join("binaries").join(&name));
    }

    candidates
}

fn backend_command(app: &tauri::App) -> Command {
    if let Ok(path) = std::env::var("ZOO_TAURI_BACKEND_BIN") {
        return Command::new(path);
    }

    if let Some(path) = sidecar_candidates(app).into_iter().find(|path| path.is_file()) {
        return Command::new(path);
    }

    let python = std::env::var("ZOO_TAURI_PYTHON").unwrap_or_else(|_| "python3".to_string());
    let mut command = Command::new(python);
    command.arg("-m").arg("zoo.desktop_backend");

    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        if let Some(root) = Path::new(&manifest_dir).parent() {
            command.current_dir(root);
        }
    }

    command
}

fn spawn_backend(app: &tauri::App) -> Result<Child, Box<dyn std::error::Error>> {
    let config_dir = app.path().app_data_dir()?.join("configs");
    std::fs::create_dir_all(&config_dir)?;

    let mut command = backend_command(app);
    command
        .env("ZOO_OPEN_BROWSER", "false")
        .env("ZOO_HOST", BACKEND_HOST)
        .env("ZOO_PORT", BACKEND_PORT)
        .env("ZOO_CONFIG_DIR", config_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    Ok(command.spawn()?)
}

fn wait_for_backend() -> bool {
    let address = format!("{BACKEND_HOST}:{BACKEND_PORT}");
    let deadline = Instant::now() + Duration::from_secs(15);

    while Instant::now() < deadline {
        if TcpStream::connect(&address).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(150));
    }

    false
}

fn stop_backend(app_handle: &tauri::AppHandle) {
    if let Some(state) = app_handle.try_state::<BackendProcess>() {
        if let Some(mut child) = state.0.lock().expect("backend mutex poisoned").take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let child = spawn_backend(app)?;
            app.manage(BackendProcess(Mutex::new(Some(child))));

            if !wait_for_backend() {
                return Err("Zoo backend did not start within 15 seconds".into());
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Zoo Tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            stop_backend(app_handle);
        }
    });
}

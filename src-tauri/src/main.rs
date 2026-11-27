#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{self, BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex, MutexGuard,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    webview::NewWindowResponse,
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
type DesktopError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Default)]
enum ServiceState {
    #[default]
    Stopped,
    Starting(Option<Child>),
    Running {
        child: Child,
        origin: String,
    },
    Paused,
    Exiting,
}

#[derive(Default)]
struct ServiceProcess {
    state: ServiceState,
    attempt: u64,
}

#[derive(Default)]
struct Service(Mutex<ServiceProcess>);

impl Service {
    fn lock(&self) -> MutexGuard<'_, ServiceProcess> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn begin_start(&self) -> io::Result<Option<u64>> {
        let mut process = self.lock();
        let start = match &mut process.state {
            ServiceState::Stopped => true,
            ServiceState::Running { child, .. } => child.try_wait()?.is_some(),
            ServiceState::Starting(_) | ServiceState::Paused | ServiceState::Exiting => false,
        };
        if !start {
            return Ok(None);
        }
        process.state = ServiceState::Starting(None);
        process.attempt += 1;
        Ok(Some(process.attempt))
    }

    fn attach(&self, attempt: u64, child: Child) -> bool {
        let mut process = self.lock();
        if process.attempt == attempt {
            if let ServiceState::Starting(slot @ None) = &mut process.state {
                *slot = Some(child);
                return true;
            }
        }
        drop(process);
        terminate(child);
        false
    }

    fn started(&self, attempt: u64, url: &tauri::Url) -> bool {
        let mut process = self.lock();
        if process.attempt == attempt {
            if let ServiceState::Starting(child) = &mut process.state {
                if let Some(child) = child.take() {
                    process.state = ServiceState::Running {
                        child,
                        origin: url.origin().ascii_serialization(),
                    };
                    return true;
                }
            }
        }
        false
    }

    fn failed(&self, attempt: u64) -> bool {
        let mut process = self.lock();
        if process.attempt != attempt || !matches!(process.state, ServiceState::Starting(_)) {
            return false;
        }
        let state = std::mem::take(&mut process.state);
        drop(process);
        if let ServiceState::Starting(Some(child)) = state {
            terminate(child);
        }
        true
    }

    fn serves(&self, url: &tauri::Url) -> bool {
        matches!(&self.lock().state, ServiceState::Running { origin, .. }
            if *origin == url.origin().ascii_serialization())
    }

    fn stop(&self, next: ServiceState) {
        let mut process = self.lock();
        if matches!(process.state, ServiceState::Exiting) {
            return;
        }
        let state = std::mem::replace(&mut process.state, next);
        drop(process);
        if let ServiceState::Running { child, .. } | ServiceState::Starting(Some(child)) = state {
            terminate(child);
        }
    }

    fn resume(&self) -> bool {
        let mut process = self.lock();
        if matches!(process.state, ServiceState::Paused) {
            process.state = ServiceState::Stopped;
            true
        } else {
            false
        }
    }
}

fn terminate(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn show_panel(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let reopening =
            !window.is_visible().unwrap_or(true) || window.is_minimized().unwrap_or(false);
        #[cfg(target_os = "macos")]
        if reopening {
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if reopening {
            let _ = window.eval("window.dispatchEvent(new Event('relay-panel-opened'))");
        }
    }
    ensure_service(app);
}

#[cfg(target_os = "macos")]
fn hide_dock_when_idle(app: &AppHandle, closing: &str) {
    if !app
        .webview_windows()
        .values()
        .any(|window| window.label() != closing && window.is_visible().unwrap_or(true))
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(
        app,
        "open-panel",
        "Открыть Naparnik Relay",
        true,
        None::<&str>,
    )?;
    let update = MenuItem::with_id(
        app,
        "tray-update",
        "Проверить обновления…",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit-relay",
        "Завершить Naparnik Relay",
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &update, &separator, &quit])?;
    #[cfg(target_os = "macos")]
    let icon = tauri::include_image!("icons/tray.png");
    #[cfg(not(target_os = "macos"))]
    let icon = tauri::include_image!("icons/32x32.png");
    tauri::tray::TrayIconBuilder::with_id("relay")
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Naparnik Relay")
        .menu(&menu)
        .build(app)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn create_macos_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::Submenu;

    let application = Submenu::with_items(
        app,
        "Naparnik Relay",
        true,
        &[&PredefinedMenuItem::quit(
            app,
            Some("Завершить Naparnik Relay"),
        )?],
    )?;
    let edit = Submenu::with_items(
        app,
        "Правка",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("Отменить"))?,
            &PredefinedMenuItem::redo(app, Some("Повторить"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("Вырезать"))?,
            &PredefinedMenuItem::copy(app, Some("Копировать"))?,
            &PredefinedMenuItem::paste(app, Some("Вставить"))?,
            &PredefinedMenuItem::select_all(app, Some("Выбрать всё"))?,
        ],
    )?;
    app.set_menu(Menu::with_items(app, &[&application, &edit])?)?;
    Ok(())
}

fn open_external(app: &AppHandle, target: &tauri::Url) {
    if target.scheme() == "https" && matches!(target.host_str(), Some("code.1c.ai" | "ingvar.pro"))
    {
        if let Err(error) = app.opener().open_url(target.as_str(), None::<&str>) {
            app.dialog()
                .message(format!("Не удалось открыть браузер. {error}"))
                .show(|_| {});
        }
    }
}

fn panel_title(app: &AppHandle) -> String {
    format!(
        "Напарник {} · Ingvar Consulting",
        app.package_info().version
    )
}

#[derive(Clone, Copy)]
enum AuxiliaryPanel {
    Tools,
    Trace,
    AuthDiagnostics,
}

impl AuxiliaryPanel {
    fn from_url(url: &tauri::Url) -> Option<Self> {
        match url.path() {
            "/tools.html" => Some(Self::Tools),
            "/trace.html" => Some(Self::Trace),
            "/auth-diagnostics.html" => Some(Self::AuthDiagnostics),
            _ => None,
        }
    }

    fn open(self, app: &AppHandle, url: tauri::Url) -> tauri::Result<()> {
        let (label, title, size, minimum) = match self {
            Self::Tools => (
                "tools",
                "Настройки · Naparnik Relay",
                (500., 600.),
                (360., 300.),
            ),
            Self::Trace => (
                "trace",
                "Трассировка · Naparnik Relay",
                (1200., 760.),
                (720., 420.),
            ),
            Self::AuthDiagnostics => (
                "auth-diagnostics",
                "Диагностика авторизации · Naparnik Relay",
                (680., 500.),
                (360., 300.),
            ),
        };
        if let Some(window) = app.get_webview_window(label) {
            if matches!(self, Self::AuthDiagnostics) && window.url()? != url {
                window.navigate(url)?;
            }
            window.show()?;
            window.unminimize()?;
            return window.set_focus();
        }

        let handle = app.clone();
        let popup_handle = app.clone();
        WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
            .title(title)
            .inner_size(size.0, size.1)
            .min_inner_size(minimum.0, minimum.1)
            .center()
            .on_navigation(move |next| {
                if handle.state::<Service>().serves(next) {
                    return true;
                }
                open_external(&handle, next);
                false
            })
            .on_new_window(move |target, _| {
                open_external(&popup_handle, &target);
                NewWindowResponse::Deny
            })
            .build()?;
        Ok(())
    }

    fn schedule(self, app: &AppHandle, mut url: tauri::Url) {
        let attempt = match self {
            Self::AuthDiagnostics => url
                .query_pairs()
                .find_map(|(name, value)| (name == "attempt").then(|| value.into_owned())),
            Self::Tools | Self::Trace => None,
        };
        url.set_query(None);
        url.set_fragment(None);
        if let Some(attempt) = attempt {
            url.query_pairs_mut().append_pair("attempt", &attempt);
        }
        let app = app.clone();
        // WebView2's navigation callback must return before creating another WebView.
        // Dispatch from a worker because run_on_main_thread is synchronous on the UI thread.
        tauri::async_runtime::spawn_blocking(move || {
            let window_app = app.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                if let Err(error) = self.open(&window_app, url) {
                    window_app
                        .dialog()
                        .message(format!("Не удалось открыть окно. {error}"))
                        .show(|_| {});
                }
            }) {
                eprintln!("Не удалось запланировать открытие окна: {error}");
            }
        });
    }
}

fn read_startup(
    out: impl io::Read + Send + 'static,
    timeout: Duration,
) -> Result<tauri::Url, DesktopError> {
    let (reply, startup) = mpsc::sync_channel(1);
    std::thread::Builder::new().spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(out).read_line(&mut line).map(|_| line);
        let _ = reply.send(result);
    })?;
    let line = startup
        .recv_timeout(timeout)
        .map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => {
                io::Error::new(io::ErrorKind::TimedOut, "Шлюз не ответил при запуске.")
            }
            mpsc::RecvTimeoutError::Disconnected => {
                io::Error::new(io::ErrorKind::BrokenPipe, "Канал запуска шлюза закрылся.")
            }
        })??;
    if line.is_empty() {
        return Err("Шлюз завершился до запуска.".into());
    }
    let startup: serde_json::Value = serde_json::from_str(&line)?;
    if let Some(message) = startup["error"].as_str() {
        return Err(message.into());
    }
    let url = tauri::Url::parse(
        startup["url"]
            .as_str()
            .ok_or("Шлюз не вернул адрес панели")?,
    )?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return Err("Шлюз вернул неверный локальный адрес".into());
    }
    Ok(url)
}

fn start_service(app: &AppHandle, attempt: u64) -> Result<Option<tauri::Url>, DesktopError> {
    let runtime = app.path().resource_dir()?.join("runtime");
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let mut command = Command::new(runtime.join(exe));
    command
        .current_dir(&runtime)
        .arg(runtime.join("desktop-server.js"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn()?;
    let Some(stdout) = child.stdout.take() else {
        terminate(child);
        return Err("Недоступен канал запуска".into());
    };
    if !app.state::<Service>().attach(attempt, child) {
        return Ok(None);
    }
    read_startup(stdout, STARTUP_TIMEOUT).map(Some)
}

fn service_error(app: &AppHandle, error: impl std::fmt::Display) {
    eprintln!("Не удалось открыть панель: {error}");
    let handle = app.clone();
    let initial_start = app.get_webview_window("main").is_none();
    app.dialog()
        .message(error.to_string())
        .title("Не удалось открыть Напарник")
        .show(move |_| {
            if initial_start && handle.get_webview_window("main").is_none() {
                handle.exit(1);
            }
        });
}

fn ensure_service(app: &AppHandle) {
    let attempt = match app.state::<Service>().begin_start() {
        Ok(None) => return,
        Err(error) => return service_error(app, error),
        Ok(Some(attempt)) => attempt,
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let startup = start_service(&app, attempt);
        let panel_app = app.clone();
        let service = app.state::<Service>();
        let scheduled = match startup {
            Ok(Some(url)) => {
                if !service.started(attempt, &url) {
                    return;
                }
                app.run_on_main_thread(move || {
                    if panel_app.state::<Service>().serves(&url) {
                        if let Err(error) = open_panel(&panel_app, url) {
                            panel_app.state::<Service>().stop(ServiceState::Stopped);
                            service_error(&panel_app, error);
                        }
                    }
                })
            }
            Ok(None) => return,
            Err(error) => {
                if !service.failed(attempt) {
                    return;
                }
                app.run_on_main_thread(move || service_error(&panel_app, error))
            }
        };
        if let Err(error) = scheduled {
            service.stop(ServiceState::Exiting);
            eprintln!("Не удалось запланировать открытие панели: {error}");
        }
    });
}

fn open_panel(app: &AppHandle, mut url: tauri::Url) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        // Reload the document with the startup token to replace the previous server's cookie.
        url.set_query(Some("reconnect"));
        return window.navigate(url);
    }
    let handle = app.clone();
    let popup_handle = app.clone();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title(panel_title(app))
        .inner_size(440., 300.)
        .resizable(false)
        .maximizable(false)
        .center()
        .on_navigation(move |next| {
            if handle.state::<Service>().serves(next) {
                if let Some(panel) = AuxiliaryPanel::from_url(next) {
                    panel.schedule(&handle, next.clone());
                    return false;
                }
                return true;
            }
            open_external(&handle, next);
            false
        })
        .on_new_window(move |target, _| {
            if popup_handle.state::<Service>().serves(&target) {
                if let Some(panel) = AuxiliaryPanel::from_url(&target) {
                    panel.schedule(&popup_handle, target);
                    return NewWindowResponse::Deny;
                }
            }
            open_external(&popup_handle, &target);
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

async fn check_update(app: &AppHandle) -> Result<(), DesktopError> {
    let window = app
        .get_webview_window("main")
        .ok_or("Окно приложения закрыто")?;
    let handle = app.clone();
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(90))
        .on_before_exit(move || handle.state::<Service>().stop(ServiceState::Paused))
        .build()?;
    let Some(update) = updater.check().await? else {
        app.dialog()
            .message(format!(
                "Установлена последняя версия Naparnik Relay {}.",
                app.package_info().version
            ))
            .title("Обновление Naparnik Relay")
            .parent(&window)
            .show(|_| {});
        return Ok(());
    };
    let install = app
        .dialog()
        .message(format!(
            "Сейчас установлена версия {}. После установки Naparnik Relay перезапустится.",
            app.package_info().version
        ))
        .title(format!("Обновить Naparnik Relay до {}?", update.version))
        .parent(&window)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Обновить".into(),
            "Позже".into(),
        ))
        .blocking_show();
    if install {
        let title = panel_title(app);
        let _ = window.set_title(&format!("{title} — Загружаем обновление…"));
        let result = update.download_and_install(|_, _| {}, || {}).await;
        let _ = window.set_title(&title);
        if let Err(error) = result {
            if app.state::<Service>().resume() {
                ensure_service(app);
            }
            return Err(error.into());
        }
        app.state::<Service>().stop(ServiceState::Exiting);
        app.restart();
    }
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_panel(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(Service::default())
        .manage(AtomicBool::new(false))
        .enable_macos_default_menu(false)
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "open-panel" => return show_panel(app),
                "quit-relay" => return app.exit(0),
                "tray-update" => show_panel(app),
                _ => return,
            }
            if app.state::<AtomicBool>().swap(true, Ordering::SeqCst) {
                return;
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = check_update(&app).await {
                    app.dialog()
                        .message(format!("Не удалось обновить приложение. {e}"))
                        .title("Обновление Naparnik Relay")
                        .show(|_| {});
                }
                app.state::<AtomicBool>().store(false, Ordering::SeqCst);
            });
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main"
                    && window.app_handle().tray_by_id("relay").is_some()
                    && window.hide().is_ok()
                {
                    api.prevent_close();
                    #[cfg(target_os = "macos")]
                    hide_dock_when_idle(window.app_handle(), window.label());
                }
            }
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::WindowEvent::Destroyed) {
                hide_dock_when_idle(window.app_handle(), window.label());
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if let Err(e) = create_macos_menu(app.handle()) {
                eprintln!("Не удалось создать системное меню Naparnik Relay: {e}");
            }
            if let Err(e) = create_tray(app.handle()) {
                eprintln!("Не удалось создать значок Naparnik Relay: {e}");
            }
            ensure_service(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Не удалось создать приложение");
    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = event
        {
            show_panel(app);
        }
        if let tauri::RunEvent::Exit = event {
            app.state::<Service>().stop(ServiceState::Exiting);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_reads_the_local_address() {
        let reply = br#"{"url":"http://127.0.0.1:47831/#fake-token"}"#;
        let url = read_startup(&reply[..], Duration::from_secs(1)).expect("valid startup reply");
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert_eq!(url.fragment(), Some("fake-token"));
    }

    #[test]
    fn startup_has_a_deadline_when_the_child_is_silent() {
        struct Silent(mpsc::Receiver<()>);

        impl io::Read for Silent {
            fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
                let _ = self.0.recv();
                Ok(0)
            }
        }

        let (release, silent) = mpsc::channel();
        let result = read_startup(Silent(silent), Duration::from_millis(20));
        drop(release);
        let error = result.expect_err("silent child must time out");
        assert_eq!(
            error.downcast_ref::<io::Error>().map(io::Error::kind),
            Some(io::ErrorKind::TimedOut)
        );
    }

    #[test]
    fn cancelled_startup_cannot_replace_a_newer_attempt() {
        let service = Service::default();
        let old = service.begin_start().unwrap().unwrap();
        service.stop(ServiceState::Paused);
        assert_eq!(service.begin_start().unwrap(), None);
        assert!(service.resume());
        let current = service.begin_start().unwrap().unwrap();
        assert!(!service.failed(old));
        assert!(service.failed(current));
        service.stop(ServiceState::Exiting);
        service.stop(ServiceState::Paused);
        assert!(!service.resume());
        assert_eq!(service.begin_start().unwrap(), None);
    }
}

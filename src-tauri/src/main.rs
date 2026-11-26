#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
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

#[derive(Default)]
struct Service(Mutex<Option<Child>>);

impl Service {
    fn stop(&self) {
        if let Some(mut child) = self.0.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
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
}

impl AuxiliaryPanel {
    fn from_url(url: &tauri::Url) -> Option<Self> {
        match url.path() {
            "/tools.html" => Some(Self::Tools),
            "/trace.html" => Some(Self::Trace),
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
        };
        if let Some(window) = app.get_webview_window(label) {
            window.show()?;
            window.unminimize()?;
            return window.set_focus();
        }

        let origin = url.origin();
        let handle = app.clone();
        let popup_handle = app.clone();
        WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
            .title(title)
            .inner_size(size.0, size.1)
            .min_inner_size(minimum.0, minimum.1)
            .center()
            .on_navigation(move |next| {
                if next.origin() == origin {
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
        url.set_query(None);
        url.set_fragment(None);
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

fn open_panel(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
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
    let out = child.stdout.take().ok_or("Недоступен канал запуска")?;
    *app.state::<Service>().0.lock().unwrap() = Some(child);
    let mut line = String::new();
    BufReader::new(out).read_line(&mut line)?;
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
    let origin = url.origin();
    let popup_origin = origin.clone();
    let handle = app.clone();
    let popup_handle = app.clone();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title(panel_title(app))
        .inner_size(440., 300.)
        .resizable(false)
        .maximizable(false)
        .center()
        .on_navigation(move |next| {
            if next.origin() == origin {
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
            if target.origin() == popup_origin {
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

async fn check_update(app: &AppHandle) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let window = app
        .get_webview_window("main")
        .ok_or("Окно приложения закрыто")?;
    let handle = app.clone();
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(90))
        .on_before_exit(move || handle.state::<Service>().stop())
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
        result?;
        app.state::<Service>().stop();
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
            if let Err(e) = create_tray(app.handle()) {
                eprintln!("Не удалось создать значок Naparnik Relay: {e}");
            }
            if let Err(e) = open_panel(app.handle()) {
                eprintln!("Не удалось открыть панель: {e}");
                app.state::<Service>().stop();
                let handle = app.handle().clone();
                app.dialog()
                    .message(e.to_string())
                    .title("Не удалось открыть Напарник")
                    .show(move |_| handle.exit(1));
            }
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
            app.state::<Service>().stop();
        }
    });
}

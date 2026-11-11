/// 按界面语言选格式串：tr!("连不上 {host}", "Can't connect to {host}")；参数写法和 format! 一样
macro_rules! tr {
    ($zh:literal, $en:literal $(, $arg:expr)* $(,)?) => {
        if crate::i18n::en() { format!($en $(, $arg)*) } else { format!($zh $(, $arg)*) }
    };
}

mod ai;
mod applog;
mod assist;
mod commands;
mod graph;
mod i18n;
mod mailbox;
mod mime;
mod net;
mod oauth;
mod os;
mod secret;
mod settings;
mod smtp;
mod store;
mod text;
mod update;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tokio::sync::mpsc;

pub struct Ctx {
    pub app: tauri::AppHandle,
    pub store: Mutex<store::Store>,
    pub status: Mutex<HashMap<i64, mailbox::Status>>,
    pub workers: Mutex<HashMap<i64, mailbox::Worker>>,
    pub ai_tx: mpsc::UnboundedSender<ai::Job>,
    pub newmail_tx: mpsc::UnboundedSender<Vec<i64>>,
    /// 等 AI 结果再提醒的新邮件：id → 加入时间
    pub pending_notify: Mutex<HashMap<i64, i64>>,
    pub pending_moves: Mutex<HashMap<u64, Vec<i64>>>,
    pub next_token: Mutex<u64>,
    pub settings_cache: Mutex<Option<settings::Settings>>,
    pub http: reqwest::Client,
}

#[cfg(windows)]
const WV_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,Translate,msEdgeTranslate,AutofillServerCommunication,OptimizationHints,MediaRouter,SpareRendererForSitePerProcess --disable-background-networking --disable-component-update --disable-sync --no-pings --disable-gpu";

/// 开机静默启动（--hidden）：前端启动完成时不弹窗口
pub static HIDDEN_START: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// 本地标记（已读、重点）每改一次加一：同步线程拿服务器标记前后对一下，变了就不把旧标记写回本地
pub static FLAG_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 缩到托盘时让 WebView2 把内存降到最低（释放缓存、压缩页面），显示时恢复
pub fn set_low_memory(w: &tauri::WebviewWindow, low: bool) {
    #[cfg(windows)]
    let _ = w.with_webview(move |wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use windows::core::Interface;
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
            let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
            let _ = c19.SetMemoryUsageTargetLevel(level);
        }
    });
}

/// 托盘菜单项：改界面语言时重设文字
pub struct TrayItems {
    open: MenuItem<tauri::Wry>,
    compose: MenuItem<tauri::Wry>,
    sync: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

impl TrayItems {
    pub fn set_texts(&self) {
        use i18n::t;
        let _ = self.open.set_text(t("打开 Kojoo Mail", "Open Kojoo Mail"));
        let _ = self.compose.set_text(t("写邮件", "New email"));
        let _ = self.sync.set_text(t("立即同步", "Sync now"));
        let _ = self.quit.set_text(t("退出", "Quit"));
    }
}

/// 磨砂玻璃用系统的亚克力材质：Windows 11 22H2（build 22621）起由系统绘制，拖动、缩放不卡；
/// 更早的系统透明窗口没有底或会卡，用不透明的
fn glass_supported() -> bool {
    if std::env::var_os("KOJOOMAIL_NO_GLASS").is_some() {
        return false;
    }
    #[cfg(windows)]
    {
        windows_registry::LOCAL_MACHINE
            .open(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
            .and_then(|k| k.get_string("CurrentBuildNumber"))
            .ok()
            .and_then(|b| b.trim().parse::<u32>().ok())
            .is_some_and(|b| b >= 22621)
    }
    #[cfg(not(windows))]
    false
}

pub fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        set_low_memory(&w, false);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 数据目录：测试时用 KOJOOMAIL_DATA 指定独立目录，不碰正式数据
fn data_dir() -> std::path::PathBuf {
    std::env::var_os("KOJOOMAIL_DATA").filter(|v| !v.is_empty()).map(std::path::PathBuf::from).unwrap_or_else(|| dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("KojooMail"))
}

pub fn run() {
    // 读到设置之前先按系统语言：启动失败的弹窗也能看懂；读到设置后按用户选的
    i18n::apply("auto");
    applog::init(&data_dir());
    let hidden_start = std::env::args().any(|a| a == "--hidden");
    HIDDEN_START.store(hidden_start, std::sync::atomic::Ordering::Relaxed);
    // 测试实例（KOJOOMAIL_DATA 指定独立数据目录）不做单实例检查，正式版开着也能跑测试
    let test_instance = std::env::var_os("KOJOOMAIL_DATA").is_some_and(|v| !v.is_empty());
    let mut builder = tauri::Builder::default();
    if !test_instance {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)));
    }
    let r = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .setup(move |app| {
            let dir = data_dir();
            // 上次打开附件时解出来的临时文件（正被别的程序占着的删不掉，跳过）
            let _ = std::fs::remove_dir_all(std::env::temp_dir().join("KojooMail"));
            let st = store::Store::open(&dir)?;
            // 上次退出时没来得及执行的移动：恢复显示
            st.conn.execute("UPDATE messages SET moving=0 WHERE moving=1", [])?;
            // 上次退出时服务器那边还没移动完的：挪回原处，同步时按服务器实际情况对账
            st.conn.execute("UPDATE messages SET folder_id=orig_folder, uid=orig_uid, orig_folder=NULL, orig_uid=NULL WHERE uid<0 AND orig_folder IS NOT NULL", [])?;
            let (ai_tx, ai_rx) = mpsc::unbounded_channel();
            let (nm_tx, mut nm_rx) = mpsc::unbounded_channel::<Vec<i64>>();
            let http = reqwest::Client::builder().pool_idle_timeout(std::time::Duration::from_secs(30)).pool_max_idle_per_host(1).build()?;
            let ctx = Arc::new(Ctx {
                app: app.handle().clone(),
                store: Mutex::new(st),
                status: Mutex::new(HashMap::new()),
                workers: Mutex::new(HashMap::new()),
                ai_tx,
                newmail_tx: nm_tx,
                pending_notify: Mutex::new(HashMap::new()),
                pending_moves: Mutex::new(HashMap::new()),
                next_token: Mutex::new(0),
                settings_cache: Mutex::new(None),
                http,
            });
            app.manage(ctx.clone());
            settings::keep_legacy_ai(&ctx);
            ai::spawn(ctx.clone(), ai_rx);
            update::spawn(app.handle().clone());

            // 新邮件提醒：会被 AI 分析的先等结果，其余马上提醒
            let c2 = ctx.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(ids) = nm_rx.recv().await {
                    let mode = settings::load(&c2).notify;
                    if mode == "none" {
                        continue;
                    }
                    // 等了 10 分钟还没出结果的（正文一直没取到等）：别再等了，直接提醒
                    let stale: Vec<i64> = {
                        let mut p = c2.pending_notify.lock().unwrap();
                        let old: Vec<i64> = p.iter().filter(|(_, t)| store::now() - **t > 600).map(|(id, _)| *id).collect();
                        old.iter().for_each(|id| { p.remove(id); });
                        old
                    };
                    for id in stale {
                        let bulk: bool = c2.store.lock().unwrap().conn.query_row("SELECT bulk FROM messages WHERE id=?", [id], |r| r.get(0)).unwrap_or(true);
                        if mode == "all" || (mode == "important" && !bulk) {
                            ai::notify_msg(&c2, id, None);
                        }
                    }
                    for id in ids {
                        // 广告、通知、订阅：当场本地分类，只有「全部提醒」才弹
                        if ai::apply_local(&c2, id).is_some() {
                            if mode == "all" {
                                ai::notify_msg(&c2, id, None);
                            }
                            continue;
                        }
                        if ai::will_auto(&c2, id) {
                            c2.pending_notify.lock().unwrap().insert(id, store::now());
                            let _ = c2.ai_tx.send(ai::Job::Auto(id));
                        } else {
                            let bulk: bool = c2.store.lock().unwrap().conn.query_row("SELECT bulk FROM messages WHERE id=?", [id], |r| r.get(0)).unwrap_or(true);
                            if mode == "all" || !bulk {
                                ai::notify_msg(&c2, id, None);
                            }
                        }
                    }
                }
            });

            // 每个账号一个同步任务
            let ids: Vec<i64> = {
                let st = ctx.store.lock().unwrap();
                let mut q = st.conn.prepare("SELECT id FROM accounts ORDER BY sort, id")?;
                let v = q.query_map([], |r| r.get(0))?.filter_map(|x| x.ok()).collect();
                v
            };
            for id in ids {
                let w = mailbox::spawn(ctx.clone(), id);
                ctx.workers.lock().unwrap().insert(id, w);
            }

            // 主窗口（代码创建：测试时可以打开 WebView2 调试端口，正式版不开）
            let mut wb = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("Kojoo Mail")
                .inner_size(1280.0, 820.0)
                .min_inner_size(960.0, 600.0)
                .visible(false)
                .center();
            #[cfg(windows)]
            {
                wb = wb.decorations(false);
            }
            #[cfg(target_os = "macos")]
            {
                wb = wb.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
            }
            // WebView2 参数：在 Tauri 默认值上关掉邮件客户端用不到的后台功能
            #[cfg(windows)]
            {
                let mut args = String::from(WV_ARGS);
                if let Ok(extra) = std::env::var("KOJOOMAIL_WV_ARGS") {
                    args = format!("{args} {extra}");
                }
                if let Ok(port) = std::env::var("KOJOOMAIL_CDP_PORT") {
                    args = format!("{args} --remote-debugging-port={port}");
                }
                wb = wb.additional_browser_args(&args);
                // 测试实例的 WebView2 数据放在测试目录里：和正在运行的正式版共用会启动失败（参数不同）
                if std::env::var_os("KOJOOMAIL_DATA").is_some_and(|v| !v.is_empty()) {
                    wb = wb.data_directory(dir.join("webview"));
                }
            }
            // 磨砂玻璃（亚克力）：标题栏和侧栏透出窗口后面实际的内容（模糊后），像微信。
            // 不用云母（Mica）：它只取系统登记的壁纸，用 Wallpaper Engine 之类时颜色和屏幕上看到的对不上
            if glass_supported() {
                wb = wb
                    .transparent(true)
                    .effects(tauri::utils::config::WindowEffectsConfig {
                        effects: vec![tauri::window::Effect::Acrylic],
                        state: None,
                        radius: None,
                        color: None,
                        ..Default::default()
                    })
                    .initialization_script("window.__KJM_GLASS__ = true");
            }
            let main = wb.build()?;
            if hidden_start {
                set_low_memory(&main, true);
            }

            // 托盘（文字按界面语言；改语言时 tray_texts 重设）
            settings::load(&ctx);
            let open = MenuItem::with_id(app, "open", "", true, None::<&str>)?;
            let compose = MenuItem::with_id(app, "compose", "", true, None::<&str>)?;
            let sync = MenuItem::with_id(app, "sync", "", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &compose, &sync, &sep, &quit])?;
            let items = TrayItems { open, compose, sync, quit };
            items.set_texts();
            app.manage(items);
            let c3 = ctx.clone();
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("icon"))
                .tooltip("Kojoo Mail")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, ev| match ev.id().as_ref() {
                    "open" => show_main(app),
                    "compose" => {
                        show_main(app);
                        let _ = tauri::Emitter::emit(app, "tray-compose", ());
                    }
                    "sync" => {
                        for w in c3.workers.lock().unwrap().values() {
                            w.send(mailbox::Op::SyncAll);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // 兜底：前端 4 秒内没把窗口显示出来就主动显示（开机静默启动除外）
            if !hidden_start {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                    if let Some(w) = h.get_webview_window("main") {
                        if !w.is_visible().unwrap_or(true) {
                            set_low_memory(&w, false);
                            let _ = w.show();
                        }
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let ctx = window.state::<Arc<Ctx>>();
                if settings::load(&ctx).close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                    if let Some(w) = window.app_handle().get_webview_window("main") {
                        set_low_memory(&w, true);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::oauth_login,
            commands::mark_view_read,
            commands::oauth_cancel,
            commands::get_counts,
            commands::category_counts,
            commands::view_ids,
            assist::digest,
            assist::digest_overview,
            assist::ai_ask,
            assist::followup_set,
            assist::ai_followup,
            commands::get_folders,
            commands::list_messages,
            commands::get_message,
            commands::mark,
            commands::snooze,
            commands::move_to,
            commands::undo_move,
            commands::delete_forever,
            commands::create_folder,
            commands::rename_folder,
            commands::delete_folder,
            commands::open_folder,
            commands::empty_folder,
            commands::open_attachment,
            commands::print_html,
            commands::sync_now,
            commands::test_account,
            commands::add_account,
            commands::update_account,
            commands::remove_account,
            commands::retry_account,
            commands::send_mail,
            commands::precheck_send,
            commands::save_draft,
            commands::list_drafts,
            commands::delete_draft,
            commands::contacts,
            commands::save_attachment,
            commands::open_url,
            commands::list_todos,
            commands::todo_set,
            commands::todo_add,
            commands::todo_delete,
            commands::ai_analyze,
            commands::ai_draft,
            commands::ai_rewrite,
            commands::ai_translate,
            commands::save_settings,
            commands::set_ai_key,
            commands::ai_test,
            commands::ai_models,
            commands::export_diagnostics,
            update::check_update,
            update::install_update,
            commands::has_ai_key,
            commands::status_list,
            commands::quit,
            commands::show_main,
            commands::ui_lang,
        ])
        .build(tauri::generate_context!());
    match r {
        Ok(app) => app.run(|_h, _ev| {
            // macOS：点 Dock 图标时，关窗口缩到后台的主窗口要重新显示
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _ev {
                show_main(_h);
            }
        }),
        Err(e) => applog::fatal(&e.to_string()),
    }
}

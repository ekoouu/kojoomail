//! 每个账号一个同步任务，只保持一条 IMAP 连接：
//!   - 空闲时在收件箱上 IDLE，服务器有新信会主动推送，不轮询
//!   - 用户操作（标已读、移动、取正文）通过队列交给它，先打断 IDLE，做完再回去等
//!   - 断线指数退避重连；密码错误连续 3 次就暂停，等用户修复，避免被服务器封号

use crate::mime;
use crate::store::{now, Store};
use crate::text;
use crate::oauth::{self, Auth};
use crate::{secret, Ctx};
use anyhow::{anyhow, Result};
use futures::TryStreamExt;
use rusqlite::params;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Notify};

type Tls = tokio_native_tls::TlsStream<TcpStream>;
type Session = async_imap::Session<Tls>;

/// 首次同步只拉最近这么多天、每个文件夹最多这么多封，旧邮件不主动下载
const INITIAL_DAYS: i64 = 60;
const INITIAL_MAX: usize = 800;
/// 收件箱最新这么多封预取正文（预览和 AI 要用），其余点开再取
const PREFETCH: usize = 40;
const IDLE_SECS: u64 = 9 * 60;
const FULL_SYNC_SECS: i64 = 15 * 60;

pub enum Op {
    Body { msg_id: i64, path: String, uid: u32, reply: oneshot::Sender<Result<(), String>> },
    Flags { path: String, uids: Vec<u32>, flag: &'static str, add: bool },
    /// ids 和 uids 一一对应；本地已先挪到目标文件夹（uid 记成 -id 占位），失败会挪回去
    Move { from: String, uids: Vec<u32>, to: String, ids: Vec<i64> },
    Delete { path: String, uids: Vec<u32> },
    /// 清空整个文件夹（只用于「已删除」「垃圾邮件」），包括本地没同步下来的旧邮件
    Empty { path: String },
    FolderCreate { parent: Option<String>, name: String, reply: oneshot::Sender<Result<(), String>> },
    FolderRename { path: String, name: String, reply: oneshot::Sender<Result<(), String>> },
    FolderDelete { path: String, reply: oneshot::Sender<Result<(), String>> },
    Append { role: &'static str, raw: Vec<u8> },
    SyncFolder { folder_id: i64 },
    SyncAll,
}

impl Op {
    /// 失败后重试用的副本（取正文的请求不重试，直接告诉界面失败）
    fn again(&self) -> Option<Op> {
        Some(match self {
            Op::Body { .. } => return None,
            Op::Flags { path, uids, flag, add } => Op::Flags { path: path.clone(), uids: uids.clone(), flag, add: *add },
            Op::Move { from, uids, to, ids } => Op::Move { from: from.clone(), uids: uids.clone(), to: to.clone(), ids: ids.clone() },
            Op::Delete { path, uids } => Op::Delete { path: path.clone(), uids: uids.clone() },
            Op::Empty { path } => Op::Empty { path: path.clone() },
            Op::FolderCreate { .. } | Op::FolderRename { .. } | Op::FolderDelete { .. } => return None,
            Op::Append { role, raw } => Op::Append { role, raw: raw.clone() },
            Op::SyncFolder { folder_id } => Op::SyncFolder { folder_id: *folder_id },
            Op::SyncAll => Op::SyncAll,
        })
    }
}

/// 一个操作最多试几次（每次失败都会断开重连）
const MAX_TRIES: u8 = 3;
/// 断线期间最多攒这么多待执行的操作
const MAX_BACKLOG: usize = 5000;
type Backlog = VecDeque<(Op, u8)>;

pub struct Worker {
    pub tx: mpsc::UnboundedSender<Op>,
    pub wake: Arc<Notify>,
    pub stop: Arc<Notify>,
    /// 用户点了「重试」/改了密码：密码错误暂停时也立刻重连
    pub force: Arc<AtomicBool>,
}

impl Worker {
    pub fn send(&self, op: Op) {
        let _ = self.tx.send(op);
        self.wake.notify_one();
    }
    pub fn retry(&self) {
        self.force.store(true, Ordering::Relaxed);
        self.wake.notify_one();
    }
}

/// 移动最终失败：把本地占位挪回原文件夹，下次同步按服务器实际情况对账
fn rollback_move(ctx: &Ctx, account_id: i64, ids: &[i64]) {
    let st = ctx.store.lock().unwrap();
    for id in ids {
        let _ = st.conn.execute(
            "UPDATE messages SET folder_id=orig_folder, uid=orig_uid, orig_folder=NULL, orig_uid=NULL WHERE id=? AND uid<0 AND orig_folder IS NOT NULL",
            [id],
        );
    }
    let _ = st.refresh_counts(account_id);
    drop(st);
    let _ = ctx.app.emit("mail-changed", serde_json::json!({ "accountId": account_id }));
}

fn give_up(ctx: &Ctx, account_id: i64, op: Op) {
    match op {
        Op::Move { ids, .. } => {
            log_line(ctx, account_id, crate::i18n::t("移动邮件多次失败，已放回原文件夹", "Moving emails failed several times; they're back in their original folder").into());
            rollback_move(ctx, account_id, &ids);
        }
        Op::Append { role, .. } => log_line(ctx, account_id, tr!("保存到「{role}」文件夹失败", "Couldn't save to the \"{role}\" folder")),
        _ => log_line(ctx, account_id, crate::i18n::t("有一个操作多次失败，已放弃", "An action failed several times and was dropped").into()),
    }
}

/// 连不上的时候：取正文的请求马上回失败，其余操作攒着等连上再做
fn park_ops(rx: &mut mpsc::UnboundedReceiver<Op>, backlog: &mut Backlog, why: &str) {
    while let Ok(op) = rx.try_recv() {
        match op {
            Op::Body { reply, .. } => {
                let _ = reply.send(Err(why.to_string()));
            }
            Op::FolderCreate { reply, .. } | Op::FolderRename { reply, .. } | Op::FolderDelete { reply, .. } => {
                let _ = reply.send(Err(why.to_string()));
            }
            op => {
                if backlog.len() < MAX_BACKLOG {
                    backlog.push_back((op, 0));
                }
            }
        }
    }
}

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub account_id: i64,
    /// connecting | syncing | idle | error | offline
    pub state: String,
    pub error: String,
    /// auth | network | ""
    pub error_kind: String,
    pub last_ok: i64,
    pub fails: u32,
    pub progress_done: u32,
    pub progress_total: u32,
    pub log: Vec<String>,
}

#[derive(Clone)]
struct Cfg {
    id: i64,
    #[allow(dead_code)]
    email: String,
    username: String,
    host: String,
    port: u16,
    provider: String,
    oauth: bool,
}

fn load_cfg(ctx: &Ctx, id: i64) -> Result<Cfg> {
    let st = ctx.store.lock().unwrap();
    Ok(st.conn.query_row(
        "SELECT id, email, username, imap_host, imap_port, provider, auth FROM accounts WHERE id=?",
        [id],
        |r| Ok(Cfg { id: r.get(0)?, email: r.get(1)?, username: r.get(2)?, host: r.get(3)?, port: r.get::<_, i64>(4)? as u16, provider: r.get(5)?, oauth: r.get::<_, String>(6)? == "oauth" }),
    )?)
}

pub struct ConnErr {
    pub auth: bool,
    pub msg: String,
}

/// XOAUTH2：第一次回应发令牌；登录失败时服务器会再发一段错误说明，回空串结束
struct XOAuth2(Option<String>);

impl async_imap::Authenticator for XOAuth2 {
    type Response = String;
    fn process(&mut self, _: &[u8]) -> String {
        self.0.take().unwrap_or_default()
    }
}

/// 连接并登录（添加账号时的测试也用它）
pub async fn connect(host: &str, port: u16, user: &str, auth: &Auth) -> Result<Session, ConnErr> {
    let net = |m: String| ConnErr { auth: false, msg: m };
    let (tcp, _) = crate::net::dial(host, port).await.map_err(net)?;
    let cx = native_tls::TlsConnector::new().map_err(|e| net(tr!("TLS 初始化失败：{e}", "TLS setup failed: {e}")))?;
    let tls = tokio::time::timeout(Duration::from_secs(15), tokio_native_tls::TlsConnector::from(cx).connect(host, tcp))
        .await
        .map_err(|_| net(crate::i18n::t("TLS 握手超时", "TLS handshake timed out").into()))?
        .map_err(|e| net(tr!("TLS 握手失败：{e}", "TLS handshake failed: {e}")))?;
    let mut client = async_imap::Client::new(tls);
    match tokio::time::timeout(Duration::from_secs(15), client.read_response()).await {
        Ok(Some(Ok(_))) => {}
        _ => return Err(net(crate::i18n::t("服务器没有响应", "The server didn't respond").into())),
    }
    let login = async {
        match auth {
            Auth::Password(p) => client.login(user, p).await,
            Auth::Bearer(t) => client.authenticate("XOAUTH2", XOAuth2(Some(format!("user={user}auth=Bearer {t}")))).await,
        }
    };
    let mut s = match tokio::time::timeout(Duration::from_secs(20), login).await {
        Err(_) => return Err(net(crate::i18n::t("登录超时", "Sign-in timed out").into())),
        Ok(Err((e, _))) => {
            let m = e.to_string();
            let auth = matches!(e, async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_));
            return Err(ConnErr { auth, msg: if auth { tr!("服务器拒绝了登录：{m}", "The server refused the sign-in: {m}") } else { m } });
        }
        Ok(Ok(s)) => s,
    };
    // 网易邮箱要求先发 ID 才允许选择文件夹；其他服务器忽略即可
    let _ = tokio::time::timeout(
        Duration::from_secs(10),
        s.id([("name", Some("KojooMail")), ("version", Some(env!("CARGO_PKG_VERSION"))), ("vendor", Some("kojoo"))]),
    )
    .await;
    Ok(s)
}

pub fn spawn(ctx: Arc<Ctx>, account_id: i64) -> Worker {
    let (tx, rx) = mpsc::unbounded_channel();
    let wake = Arc::new(Notify::new());
    let stop = Arc::new(Notify::new());
    let force = Arc::new(AtomicBool::new(false));
    let w = Worker { tx, wake: wake.clone(), stop: stop.clone(), force: force.clone() };
    tauri::async_runtime::spawn(run(ctx, account_id, rx, wake, stop, force));
    w
}

fn set_status(ctx: &Ctx, id: i64, f: impl FnOnce(&mut Status)) {
    let mut lines: Vec<(&str, String)> = Vec::new();
    let snap = {
        let mut map = ctx.status.lock().unwrap();
        let s = map.entry(id).or_insert_with(|| Status { account_id: id, ..Default::default() });
        let (state, error, logs) = (s.state.clone(), s.error.clone(), s.log.len());
        f(s);
        // 要写进日志文件的：新出现的错误、从出错恢复、过程记录（都不含邮件内容）。锁外再写
        let bad = |x: &str| x == "error" || x == "offline";
        if s.error != error && !s.error.is_empty() {
            lines.push(("WARN", format!("账号 {id} {} {} {}", s.state, s.error_kind, s.error)));
        } else if bad(&state) && s.state == "idle" {
            lines.push(("INFO", format!("账号 {id} 已恢复")));
        }
        lines.extend(s.log.iter().skip(logs).map(|l| ("INFO", format!("账号 {id} {l}"))));
        if s.log.len() > 20 {
            let n = s.log.len() - 20;
            s.log.drain(0..n);
        }
        s.clone()
    };
    for (level, l) in lines {
        crate::applog::write(level, &l);
    }
    let _ = ctx.app.emit("account-status", snap);
}

/// 服务器回了解析不了的话（比如 Outlook 断开前的「Unavailable … BYE」），错误里是一串字节数字：还原成文字，只留第一行
fn readable(e: &str) -> String {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"Error\(Error \{ input: \[([0-9, ]+)\].*").unwrap());
    RE.replace(e, |c: &regex::Captures| {
        let bytes: Vec<u8> = c[1].split(", ").filter_map(|n| n.trim().parse().ok()).collect();
        let text = String::from_utf8_lossy(&bytes);
        tr!("服务器回了无法识别的内容：{}", "The server sent an unrecognized response: {}", text.lines().next().unwrap_or("").trim())
    })
    .into_owned()
}

fn log_line(ctx: &Ctx, id: i64, line: String) {
    let t = chrono::Local::now().format("%m-%d %H:%M:%S");
    set_status(ctx, id, |s| s.log.push(format!("{t} {line}")));
}

async fn run(ctx: Arc<Ctx>, id: i64, rx: mpsc::UnboundedReceiver<Op>, wake: Arc<Notify>, stop: Arc<Notify>, force: Arc<AtomicBool>) {
    let mut backoff = 10u64;
    let mut auth_fails = 0u32;
    let mut serve_fails = 0u32;
    let mut rx = Some(rx);
    let mut backlog: Backlog = VecDeque::new();
    loop {
        let cfg = match load_cfg(&ctx, id) {
            Ok(c) => c,
            Err(_) => return, // 账号被删了
        };
        let Some(stored) = secret::get(&secret::account_key(id)) else {
            set_status(&ctx, id, |s| { s.state = "error".into(); s.error_kind = "auth".into(); s.error = crate::i18n::t("没有找到这个账号的密码，请重新填写", "No password found for this account. Please enter it again.").into(); });
            loop {
                tokio::select! { _ = wake.notified() => {}, _ = stop.notified() => return }
                park_ops(rx.as_mut().unwrap(), &mut backlog, crate::i18n::t("这个账号还没有密码", "This account has no password yet"));
                if secret::get(&secret::account_key(id)).is_some() {
                    break;
                }
            }
            continue;
        };
        set_status(&ctx, id, |s| s.state = "connecting".into());
        // 一键登录的账号：先用长期授权换短期令牌（换不到时同样分授权失效 / 网络问题）
        let auth = if cfg.oauth {
            oauth::access_token(&ctx.http, id, &cfg.provider).await.map(Auth::Bearer).map_err(|e| ConnErr { auth: e.auth, msg: e.msg })
        } else {
            Ok(Auth::Password(stored))
        };
        // 用户改密码 / 重新登录时版本号会加一（见 secret::cred_gen）
        let base = secret::cred_gen(id);
        let res = match auth {
            Ok(a) => connect(&cfg.host, cfg.port, &cfg.username, &a).await,
            Err(e) => Err(e),
        };
        match res {
            Err(e) => {
                log_line(&ctx, id, tr!("连接失败：{}", "Connection failed: {}", e.msg));
                if e.auth {
                    oauth::forget(id);
                    auth_fails += 1;
                    let paused = auth_fails >= 3;
                    set_status(&ctx, id, |s| {
                        s.state = "error".into();
                        s.error_kind = "auth".into();
                        s.error = e.msg.clone();
                        s.fails = auth_fails;
                    });
                    // 密码错了：重试几次（可能是服务器抽风），连续 3 次就停。
                    // 平时的操作（点开邮件、标星）不会触发重新登录，只有改了密码或点「重试」才会，免得被服务器封号
                    let wait = if paused { 24 * 3600 } else { 60 };
                    let deadline = tokio::time::Instant::now() + Duration::from_secs(wait);
                    loop {
                        tokio::select! {
                            _ = tokio::time::sleep_until(deadline) => break,
                            _ = wake.notified() => {
                                park_ops(rx.as_mut().unwrap(), &mut backlog, crate::i18n::t("账号授权失效，请先修复", "The account's authorization has expired. Fix it first."));
                                let changed = secret::cred_gen(id) != base;
                                if force.swap(false, Ordering::Relaxed) || changed {
                                    auth_fails = 0;
                                    break;
                                }
                            }
                            _ = stop.notified() => return,
                        }
                    }
                } else {
                    set_status(&ctx, id, |s| { s.state = "offline".into(); s.error_kind = "network".into(); s.error = e.msg.clone(); });
                    let deadline = tokio::time::Instant::now() + Duration::from_secs(backoff);
                    loop {
                        tokio::select! {
                            _ = tokio::time::sleep_until(deadline) => break,
                            _ = wake.notified() => {
                                park_ops(rx.as_mut().unwrap(), &mut backlog, crate::i18n::t("邮件服务器暂时连不上", "Can't reach the mail server right now"));
                                if force.swap(false, Ordering::Relaxed) {
                                    break;
                                }
                            }
                            _ = stop.notified() => return,
                        }
                    }
                    backoff = (backoff * 2).min(300);
                }
                park_ops(rx.as_mut().unwrap(), &mut backlog, crate::i18n::t("邮件服务器暂时连不上", "Can't reach the mail server right now"));
            }
            Ok(session) => {
                backoff = 10;
                auth_fails = 0;
                force.store(false, Ordering::Relaxed);
                log_line(&ctx, id, crate::i18n::t("已连接", "Connected").into());
                let started = now();
                let mut w = SessionWorker {
                    ctx: ctx.clone(),
                    cfg,
                    s: Some(session),
                    selected: String::new(),
                    caps: HashSet::new(),
                    last_full: 0,
                    rx: rx.take().unwrap(),
                    backlog: std::mem::take(&mut backlog),
                };
                let r = w.serve(&wake, &stop).await;
                if let Some(s) = w.s.take() {
                    let _ = tokio::time::timeout(Duration::from_secs(5), async move { let mut s = s; s.logout().await }).await;
                }
                rx = Some(w.rx);
                backlog = w.backlog;
                match r {
                    Ok(()) => return, // 收到停止信号
                    Err(e) => {
                        let e = readable(&e.to_string());
                        log_line(&ctx, id, tr!("连接中断：{e}", "Connection lost: {e}"));
                        set_status(&ctx, id, |s| { s.state = "offline".into(); s.error_kind = "network".into(); s.error = e.clone(); });
                        // 连上没多久又出错（多半每次都会错）：越等越久，别每 5 秒重来一遍
                        serve_fails = if now() - started < 120 { serve_fails + 1 } else { 1 };
                        let wait = (5u64 << (serve_fails - 1).min(6)).min(300);
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(wait)) => {}
                            _ = stop.notified() => return,
                        }
                        park_ops(rx.as_mut().unwrap(), &mut backlog, crate::i18n::t("邮件服务器暂时连不上", "Can't reach the mail server right now"));
                    }
                }
            }
        }
    }
}

struct SessionWorker {
    ctx: Arc<Ctx>,
    cfg: Cfg,
    s: Option<Session>,
    selected: String,
    caps: HashSet<String>,
    last_full: i64,
    rx: mpsc::UnboundedReceiver<Op>,
    backlog: Backlog,
}

#[derive(Clone)]
struct FolderRow {
    id: i64,
    path: String,
    role: String,
    uidvalidity: i64,
    last_sync: i64,
}

impl SessionWorker {
    fn sess(&mut self) -> &mut Session {
        self.s.as_mut().expect("session")
    }

    /// 依次执行排队的操作；失败的放回队首（最多试 MAX_TRIES 次），并断开重连
    async fn run_ops(&mut self) -> Result<()> {
        while let Ok(op) = self.rx.try_recv() {
            self.backlog.push_back((op, 0));
        }
        while let Some((op, tries)) = self.backlog.pop_front() {
            let again = op.again();
            if let Err(e) = self.do_op(op).await {
                if let Some(a) = again {
                    if tries + 1 < MAX_TRIES {
                        self.backlog.push_front((a, tries + 1));
                    } else {
                        give_up(&self.ctx, self.cfg.id, a);
                    }
                }
                return Err(e);
            }
        }
        Ok(())
    }

    /// 长时间同步中途插空：用户点开的邮件取正文、标记已读/星标马上做，其余等同步完
    async fn quick_ops(&mut self) -> Result<()> {
        while let Ok(op) = self.rx.try_recv() {
            self.backlog.push_back((op, 0));
        }
        let mut rest = VecDeque::new();
        while let Some((op, tries)) = self.backlog.pop_front() {
            if matches!(op, Op::Body { .. } | Op::Flags { .. }) {
                let again = op.again();
                if let Err(e) = self.do_light(op).await {
                    if let Some(a) = again {
                        rest.push_back((a, tries + 1));
                    }
                    rest.extend(self.backlog.drain(..));
                    self.backlog = rest;
                    return Err(e);
                }
            } else {
                rest.push_back((op, tries));
            }
        }
        self.backlog = rest;
        Ok(())
    }

    async fn serve(&mut self, wake: &Arc<Notify>, stop: &Arc<Notify>) -> Result<()> {
        let caps = self.sess().capabilities().await?;
        for c in ["IDLE", "MOVE", "UIDPLUS", "SPECIAL-USE"] {
            if caps.has_str(c) {
                self.caps.insert(c.to_string());
            }
        }
        self.sync_folder_list().await?;
        self.full_sync().await?;
        loop {
            // 先把排队的操作做完
            self.run_ops().await?;
            if now() - self.last_full > FULL_SYNC_SECS {
                self.full_sync().await?;
                continue;
            }
            set_status(&self.ctx, self.cfg.id, |s| { s.state = "idle".into(); s.error.clear(); s.error_kind.clear(); s.last_ok = now(); });
            // 然后在收件箱上等新邮件 / 新操作 / 停止
            let woke = self.wait(wake, stop).await?;
            match woke {
                Wake::Stop => return Ok(()),
                Wake::NewMail => {
                    if let Some(inbox) = self.folder_by_role("inbox") {
                        self.sync_folder(&inbox, true).await?;
                        self.after_inbox_sync().await;
                    }
                }
                Wake::Timeout | Wake::Op => {}
            }
        }
    }

    async fn wait(&mut self, wake: &Arc<Notify>, stop: &Arc<Notify>) -> Result<Wake> {
        if !self.caps.contains("IDLE") {
            // 不支持 IDLE 的服务器（163 等）：每分钟问一次收件箱状态，UIDNEXT 变了就是来了新信，最多 5 分钟做一次完整同步。
            // 必须是 STATUS 这类真命令：163 不把 NOOP 算活动，4 分钟就「Autologout; idle for too long」，每次查信都得重新登录（实测）
            let inbox = self.folder_by_role("inbox").map(|f| f.path).unwrap_or_else(|| "INBOX".into());
            let first = self.uid_next(&inbox).await?;
            for _ in 0..5 {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(60)) => {}
                    _ = wake.notified() => return Ok(Wake::Op),
                    _ = stop.notified() => return Ok(Wake::Stop),
                }
                if self.uid_next(&inbox).await? != first {
                    return Ok(Wake::NewMail);
                }
            }
            return Ok(Wake::NewMail);
        }
        let inbox = self.folder_by_role("inbox").map(|f| f.path).unwrap_or_else(|| "INBOX".into());
        self.select(&inbox).await?;
        let session = self.s.take().expect("session");
        let mut handle = session.idle();
        if let Err(e) = handle.init().await {
            return Err(anyhow!(tr!("IDLE 失败：{e}", "IDLE failed: {e}")));
        }
        let outcome = {
            let (fut, _stop_src) = handle.wait_with_timeout(Duration::from_secs(IDLE_SECS));
            tokio::select! {
                r = fut => match r {
                    Ok(async_imap::extensions::idle::IdleResponse::NewData(_)) => Wake::NewMail,
                    Ok(_) => Wake::Timeout,
                    Err(e) => return Err(anyhow!(tr!("IDLE 中断：{e}", "IDLE interrupted: {e}"))),
                },
                _ = wake.notified() => Wake::Op,
                _ = stop.notified() => Wake::Stop,
            }
        };
        let session = tokio::time::timeout(Duration::from_secs(20), handle.done())
            .await
            .map_err(|_| anyhow!("{}", crate::i18n::t("退出 IDLE 超时", "Leaving IDLE timed out")))??;
        self.s = Some(session);
        Ok(outcome)
    }

    async fn uid_next(&mut self, path: &str) -> Result<Option<u32>> {
        let mb = tokio::time::timeout(Duration::from_secs(20), self.sess().status(path, "(UIDNEXT)"))
            .await
            .map_err(|_| anyhow!("{}", crate::i18n::t("服务器没有响应", "The server didn't respond")))??;
        Ok(mb.uid_next)
    }

    async fn select(&mut self, path: &str) -> Result<async_imap::types::Mailbox> {
        let mb = self.sess().select(path).await?;
        self.selected = path.to_string();
        Ok(mb)
    }

    fn folder_by_role(&self, role: &str) -> Option<FolderRow> {
        let st = self.ctx.store.lock().unwrap();
        st.conn
            .query_row(
                "SELECT id, path, role, uidvalidity, last_sync FROM folders WHERE account_id=? AND role=? LIMIT 1",
                params![self.cfg.id, role],
                |r| Ok(FolderRow { id: r.get(0)?, path: r.get(1)?, role: r.get(2)?, uidvalidity: r.get(3)?, last_sync: r.get(4)? }),
            )
            .ok()
    }

    fn folder_by_id(&self, id: i64) -> Option<FolderRow> {
        let st = self.ctx.store.lock().unwrap();
        st.conn
            .query_row(
                "SELECT id, path, role, uidvalidity, last_sync FROM folders WHERE id=? AND account_id=?",
                params![id, self.cfg.id],
                |r| Ok(FolderRow { id: r.get(0)?, path: r.get(1)?, role: r.get(2)?, uidvalidity: r.get(3)?, last_sync: r.get(4)? }),
            )
            .ok()
    }

    async fn sync_folder_list(&mut self) -> Result<()> {
        let names: Vec<async_imap::types::Name> = self.sess().list(Some(""), Some("*")).await?.try_collect().await?;
        let gmail = self.cfg.host.contains("gmail") || self.cfg.provider == "gmail";
        let mut seen_roles = HashSet::new();
        let mut rows = vec![];
        for n in &names {
            let attrs: Vec<String> = n.attributes().iter().map(|a| format!("{a:?}").to_lowercase()).collect();
            if attrs.iter().any(|a| a.contains("noselect") || a.contains("nonexistent")) {
                continue;
            }
            let path = n.name().to_string();
            let delim = n.delimiter().unwrap_or("/");
            let decoded = text::decode_mutf7(&path);
            let leaf = decoded.rsplit(delim).next().unwrap_or(&decoded).to_string();
            let lower = decoded.to_lowercase();
            let mut role = if path.eq_ignore_ascii_case("INBOX") {
                "inbox"
            } else if attrs.iter().any(|a| a == "sent") {
                "sent"
            } else if attrs.iter().any(|a| a == "drafts") {
                "drafts"
            } else if attrs.iter().any(|a| a == "trash") {
                "trash"
            } else if attrs.iter().any(|a| a == "junk") {
                "junk"
            } else if attrs.iter().any(|a| a == "archive") {
                "archive"
            } else if attrs.iter().any(|a| a == "all") {
                "all"
            } else if attrs.iter().any(|a| a == "flagged") {
                "starred"
            } else {
                ""
            };
            if role.is_empty() {
                role = match leaf.to_lowercase().as_str() {
                    "sent" | "sent messages" | "sent items" | "sent mail" | "已发送" | "已发送邮件" => "sent",
                    "drafts" | "draft" | "草稿" | "草稿箱" => "drafts",
                    "trash" | "deleted" | "deleted messages" | "deleted items" | "已删除" | "已删除邮件" => "trash",
                    "junk" | "spam" | "junk e-mail" | "junk email" | "垃圾邮件" | "垃圾箱" => "junk",
                    "archive" | "archives" | "归档" => "archive",
                    _ => "",
                };
            }
            if gmail && lower.contains("[gmail]/important") {
                continue; // Gmail 的「重要」是视图，不同步
            }
            if !role.is_empty() && !seen_roles.insert(role) {
                role = ""; // 同一角色只认第一个
            }
            rows.push((path, leaf, role.to_string()));
        }
        let st = self.ctx.store.lock().unwrap();
        let existing: Vec<(i64, String)> = {
            let mut q = st.conn.prepare("SELECT id, path FROM folders WHERE account_id=?")?;
            let v = q.query_map([self.cfg.id], |r| Ok((r.get(0)?, r.get(1)?)))?.filter_map(|x| x.ok()).collect();
            v
        };
        let keep: HashSet<&String> = rows.iter().map(|r| &r.0).collect();
        for (fid, p) in &existing {
            if !keep.contains(p) {
                // 有本机刚挪进来的占位（文件夹还在创建中）先不删
                let pending: i64 = st.conn.query_row("SELECT COUNT(*) FROM messages WHERE folder_id=? AND uid<0", [fid], |r| r.get(0))?;
                if pending > 0 {
                    continue;
                }
                let ids: Vec<i64> = {
                    let mut q = st.conn.prepare("SELECT id FROM messages WHERE folder_id=?")?;
                    let v = q.query_map([fid], |r| r.get(0))?.filter_map(|x| x.ok()).collect();
                    v
                };
                st.delete_messages(&ids)?; // 连同搜索索引和 .eml 一起清
                st.conn.execute("DELETE FROM folders WHERE id=?", [fid])?;
            }
        }
        for (path, name, role) in rows {
            st.conn.execute(
                "INSERT INTO folders(account_id, path, name, role) VALUES(?,?,?,?)
                 ON CONFLICT(account_id, path) DO UPDATE SET name=excluded.name, role=excluded.role",
                params![self.cfg.id, path, name, role],
            )?;
        }
        drop(st);
        let _ = self.ctx.app.emit("mail-changed", serde_json::json!({ "accountId": self.cfg.id, "folders": true }));
        Ok(())
    }

    async fn full_sync(&mut self) -> Result<()> {
        set_status(&self.ctx, self.cfg.id, |s| s.state = "syncing".into());
        let folders: Vec<FolderRow> = {
            let st = self.ctx.store.lock().unwrap();
            let mut q = st.conn.prepare(
                "SELECT id, path, role, uidvalidity, last_sync FROM folders WHERE account_id=? AND role IN ('inbox','sent','drafts','junk','archive','trash')
                 ORDER BY CASE role WHEN 'inbox' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END",
            )?;
            let v = q
                .query_map([self.cfg.id], |r| Ok(FolderRow { id: r.get(0)?, path: r.get(1)?, role: r.get(2)?, uidvalidity: r.get(3)?, last_sync: r.get(4)? }))?
                .filter_map(|x| x.ok())
                .collect();
            v
        };
        let total = folders.len() as u32;
        for (i, f) in folders.iter().enumerate() {
            set_status(&self.ctx, self.cfg.id, |s| { s.progress_done = i as u32; s.progress_total = total; });
            self.quick_ops().await?;
            self.sync_folder(f, f.role == "inbox").await?;
            if f.role == "inbox" {
                self.after_inbox_sync().await;
            }
        }
        set_status(&self.ctx, self.cfg.id, |s| { s.progress_done = total; s.progress_total = total; });
        self.last_full = now();
        Ok(())
    }

    /// 同步一个文件夹：新邮件头 + 已有邮件的已读/星标/删除变化
    async fn sync_folder(&mut self, f: &FolderRow, notify_new: bool) -> Result<()> {
        let mb = self.select(&f.path).await?;
        let uv = mb.uid_validity.unwrap_or(0) as i64;
        let (local_count, local_max, local_min): (i64, i64, i64) = {
            let st = self.ctx.store.lock().unwrap();
            if f.uidvalidity != 0 && uv != 0 && f.uidvalidity != uv {
                // 服务器重建了文件夹：本地缓存作废
                let ids: Vec<i64> = {
                    let mut q = st.conn.prepare("SELECT id FROM messages WHERE folder_id=?")?;
                    let v = q.query_map([f.id], |r| r.get(0))?.filter_map(|x| x.ok()).collect();
                    v
                };
                st.delete_messages(&ids)?;
            }
            st.conn.execute("UPDATE folders SET uidvalidity=? WHERE id=?", params![uv, f.id])?;
            // uid<0 是刚挪进来、还没对上服务器 UID 的占位，不算
            st.conn.query_row("SELECT COUNT(*), IFNULL(MAX(uid),0), IFNULL(MIN(uid),0) FROM messages WHERE folder_id=? AND uid>0", [f.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        };

        // 1. 新邮件
        let new_uids: Vec<u32> = if mb.exists == 0 {
            vec![]
        } else if local_count == 0 {
            let since = chrono::Utc::now() - chrono::Duration::days(INITIAL_DAYS);
            let q = format!("SINCE {}", since.format("%d-%b-%Y"));
            let mut v: Vec<u32> = self.sess().uid_search(&q).await?.into_iter().collect();
            v.sort_unstable_by(|a, b| b.cmp(a));
            v.truncate(INITIAL_MAX);
            v
        } else {
            let found: HashSet<u32> = self.sess().uid_search(format!("UID {}:*", local_max + 1)).await?;
            let mut v: Vec<u32> = found.into_iter().filter(|u| *u as i64 > local_max).collect();
            v.sort_unstable_by(|a, b| b.cmp(a));
            v
        };
        // 第一次同步这个文件夹（不是「本地刚好清空了」）才算首次，首次不发提醒
        let initial = f.last_sync == 0;
        let mut inserted = vec![];
        for chunk in new_uids.chunks(150) {
            let set = chunk.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
            let fetches: Vec<async_imap::types::Fetch> = self
                .sess()
                .uid_fetch(&set, "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER])")
                .await?
                .try_collect()
                .await?;
            let st = self.ctx.store.lock().unwrap();
            let tx = st.conn.unchecked_transaction()?;
            for ft in &fetches {
                let Some(uid) = ft.uid else { continue };
                let h = mime::parse_head(ft.header().unwrap_or(b""));
                let (mut seen, mut flagged, mut answered) = (false, false, false);
                for fl in ft.flags() {
                    match fl {
                        async_imap::types::Flag::Seen => seen = true,
                        async_imap::types::Flag::Flagged => flagged = true,
                        async_imap::types::Flag::Answered => answered = true,
                        _ => {}
                    }
                }
                // 本机刚挪进来的邮件：按 Message-ID 对上占位，保留正文、AI 批注和待办
                if !h.msgid.is_empty() {
                    let n = tx.execute(
                        "UPDATE messages SET uid=?, seen=?, flagged=?, answered=?, orig_folder=NULL, orig_uid=NULL
                         WHERE id=(SELECT id FROM messages WHERE folder_id=? AND uid<0 AND msgid=? LIMIT 1)",
                        params![uid, seen, flagged, answered, f.id, h.msgid],
                    )?;
                    if n > 0 {
                        continue;
                    }
                }
                let date = if h.date > 0 { h.date } else { ft.internal_date().map(|d| d.timestamp()).unwrap_or_else(now) };
                let n = tx.execute(
                    "INSERT OR IGNORE INTO messages(account_id, folder_id, uid, msgid, in_reply_to, refs, from_name, from_addr, to_json, cc_json, reply_to, subject, date, seen, flagged, answered, has_att, bulk, size)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    params![
                        self.cfg.id, f.id, uid, h.msgid, h.in_reply_to, h.refs, h.from.name, h.from.email,
                        serde_json::to_string(&h.to)?, serde_json::to_string(&h.cc)?, h.reply_to, h.subject, date,
                        seen, flagged, answered, h.multipart_mixed, if h.subscription { 2 } else { h.bulk as i64 }, ft.size.unwrap_or(0)
                    ],
                )?;
                if n > 0 {
                    let id = tx.last_insert_rowid();
                    let people = format!("{} {} {}", h.from.name, h.from.email, h.to.iter().map(|a| format!("{} {}", a.name, a.email)).collect::<Vec<_>>().join(" "));
                    tx.execute("INSERT INTO msg_fts(rowid, subject, people, body) VALUES(?,?,?,'')", params![id, h.subject, people])?;
                    inserted.push((id, seen, h.bulk, date));
                }
            }
            tx.commit()?;
        }

        // 2. 已有邮件的标记变化和删除（只看本地已有范围）。先把排队的标记推上去，免得刚标的已读被旧状态盖回去
        if local_count > 0 {
            self.quick_ops().await?;
            let gen0 = crate::FLAG_GEN.load(std::sync::atomic::Ordering::SeqCst);
            if self.selected != f.path {
                self.select(&f.path).await?;
            }
            let fetches: Vec<async_imap::types::Fetch> = self.sess().uid_fetch(format!("{}:{}", local_min, local_max), "(UID FLAGS)").await?.try_collect().await?;
            let mut server: HashMap<u32, (bool, bool, bool)> = HashMap::new();
            for ft in &fetches {
                let Some(uid) = ft.uid else { continue };
                let mut t = (false, false, false);
                for fl in ft.flags() {
                    match fl {
                        async_imap::types::Flag::Seen => t.0 = true,
                        async_imap::types::Flag::Flagged => t.1 = true,
                        async_imap::types::Flag::Answered => t.2 = true,
                        _ => {}
                    }
                }
                server.insert(uid, t);
            }
            let st = self.ctx.store.lock().unwrap();
            let locals: Vec<(i64, u32, bool, bool, bool)> = {
                let mut q = st.conn.prepare("SELECT id, uid, seen, flagged, answered FROM messages WHERE folder_id=? AND uid BETWEEN ? AND ?")?;
                let v = q
                    .query_map(params![f.id, local_min, local_max], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
                    .filter_map(|x| x.ok())
                    .collect();
                v
            };
            let mut gone = vec![];
            // 拿服务器标记期间用户在本地标过（比如一键已读）：这轮不覆盖标记，等排队的操作推上去后下轮再对
            let flags_fresh = crate::FLAG_GEN.load(std::sync::atomic::Ordering::SeqCst) == gen0;
            let tx = st.conn.unchecked_transaction()?;
            for (id, uid, seen, flagged, answered) in locals {
                match server.get(&uid) {
                    None => gone.push(id),
                    Some(&(s2, f2, a2)) if flags_fresh && (s2, f2, a2) != (seen, flagged, answered) => {
                        tx.execute("UPDATE messages SET seen=?, flagged=?, answered=? WHERE id=?", params![s2, f2, a2, id])?;
                    }
                    _ => {}
                }
            }
            tx.commit()?;
            st.delete_messages(&gone)?;
        }
        {
            let st = self.ctx.store.lock().unwrap();
            st.conn.execute("UPDATE folders SET last_sync=? WHERE id=?", params![now(), f.id])?;
            st.refresh_counts(self.cfg.id)?;
        }
        let _ = self.ctx.app.emit("mail-changed", serde_json::json!({ "accountId": self.cfg.id, "folderId": f.id }));

        // 3. 新邮件提醒（首次同步不提醒；未读、两天内的才算）
        if notify_new && !initial {
            let fresh: Vec<i64> = inserted.iter().filter(|(_, seen, _, date)| !seen && now() - date < 2 * 86400).map(|x| x.0).collect();
            if !fresh.is_empty() {
                let _ = self.ctx.newmail_tx.send(fresh);
            }
        }
        Ok(())
    }

    /// 收件箱同步后：预取最新几十封的正文（预览和 AI 要用）
    async fn after_inbox_sync(&mut self) {
        let Some(inbox) = self.folder_by_role("inbox") else { return };
        let todo: Vec<(i64, u32)> = {
            let st = self.ctx.store.lock().unwrap();
            let mut q = match st.conn.prepare(
                "SELECT id, uid FROM messages WHERE folder_id=? AND has_body=0 AND size < 8000000 AND date > ? ORDER BY date DESC LIMIT ?",
            ) {
                Ok(q) => q,
                Err(_) => return,
            };
            let v = q
                .query_map(params![inbox.id, now() - 30 * 86400, PREFETCH as i64], |r| Ok((r.get(0)?, r.get(1)?)))
                .map(|it| it.filter_map(|x| x.ok()).collect())
                .unwrap_or_default();
            v
        };
        for (id, uid) in todo {
            if self.quick_ops().await.is_err() {
                break;
            }
            if self.fetch_body(id, &inbox.path, uid).await.is_err() {
                break;
            }
            let _ = self.ctx.ai_tx.send(crate::ai::Job::Auto(id));
        }
    }

    async fn fetch_body(&mut self, msg_id: i64, path: &str, uid: u32) -> Result<()> {
        if self.selected != path {
            self.select(path).await?;
        }
        let fetches: Vec<async_imap::types::Fetch> = self.sess().uid_fetch(uid.to_string(), "(UID BODY.PEEK[])").await?.try_collect().await?;
        let raw = fetches.iter().find_map(|f| f.body().map(|b| b.to_vec())).ok_or_else(|| anyhow!("{}", crate::i18n::t("服务器上找不到这封邮件了", "This email is no longer on the server")))?;
        store_body(&self.ctx, msg_id, &raw)?;
        Ok(())
    }

    /// 不会触发同步的轻操作：取正文、改标记（同步中途也能插空做）
    async fn do_light(&mut self, op: Op) -> Result<()> {
        match op {
            Op::Body { msg_id, path, uid, reply } => {
                let r = self.fetch_body(msg_id, &path, uid).await;
                let failed_conn = r.as_ref().err().map(|e| e.downcast_ref::<async_imap::error::Error>().is_some()).unwrap_or(false);
                let _ = reply.send(r.as_ref().map(|_| ()).map_err(|e| e.to_string()));
                if failed_conn {
                    return Err(anyhow!("{}", crate::i18n::t("取正文时连接出错", "Connection error while fetching the email body")));
                }
            }
            Op::Flags { path, uids, flag, add } => {
                if uids.is_empty() {
                    return Ok(());
                }
                self.select(&path).await?;
                let q = format!("{}FLAGS.SILENT ({})", if add { "+" } else { "-" }, flag);
                for set in uid_sets(&uids) {
                    let _: Vec<_> = self.sess().uid_store(&set, &q).await?.try_collect().await?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn hierarchy_delimiter(&mut self) -> Result<String> {
        let names: Vec<async_imap::types::Name> = self.sess().list(Some(""), Some("%")).await?.try_collect().await?;
        Ok(names.iter().find_map(|n| n.delimiter()).unwrap_or("/").to_string())
    }

    fn folder_leaf(path: &str, delimiter: &str) -> String {
        let decoded = text::decode_mutf7(path);
        decoded.rsplit(delimiter).next().unwrap_or(&decoded).to_string()
    }

    fn checked_folder_name(name: &str, delimiter: &str) -> Result<String> {
        let name = name.trim();
        if name.is_empty() {
            return Err(anyhow!("{}", crate::i18n::t("文件夹名称不能为空", "Folder name can't be empty")));
        }
        if name.chars().any(|c| c.is_control()) || name.contains(delimiter) {
            return Err(anyhow!(tr!("文件夹名称不能包含「{delimiter}」", "Folder names can't contain \"{delimiter}\"")));
        }
        Ok(name.to_string())
    }

    async fn create_folder(&mut self, parent: Option<String>, name: String) -> Result<()> {
        let delimiter = self.hierarchy_delimiter().await?;
        let name = Self::checked_folder_name(&name, &delimiter)?;
        let encoded = text::encode_mutf7(&name);
        let path = parent.map(|p| format!("{p}{delimiter}{encoded}")).unwrap_or(encoded);
        self.sess().create(&path).await.map_err(|e| anyhow!(tr!("创建文件夹「{name}」失败：{e}", "Couldn't create folder \"{name}\": {e}")))?;
        self.sync_folder_list().await?;
        Ok(())
    }

    async fn rename_folder(&mut self, path: String, name: String) -> Result<()> {
        let delimiter = self.hierarchy_delimiter().await?;
        let name = Self::checked_folder_name(&name, &delimiter)?;
        let encoded = text::encode_mutf7(&name);
        let parent = path.rsplit_once(&delimiter).map(|(p, _)| p);
        let new_path = parent.map(|p| format!("{p}{delimiter}{encoded}")).unwrap_or(encoded);
        if new_path == path {
            return Ok(());
        }
        let old_prefix = format!("{path}{delimiter}");
        if self.selected == path || self.selected.starts_with(&old_prefix) {
            let _ = self.select("INBOX").await;
        }
        self.sess().rename(&path, &new_path).await.map_err(|e| anyhow!(tr!("重命名文件夹失败：{e}", "Couldn't rename folder: {e}")))?;
        let new_prefix = format!("{new_path}{delimiter}");
        {
            let st = self.ctx.store.lock().unwrap();
            let rows: Vec<(i64, String)> = {
                let mut q = st.conn.prepare("SELECT id, path FROM folders WHERE account_id=?")?;
                let v = q.query_map([self.cfg.id], |r| Ok((r.get(0)?, r.get(1)?)))?.filter_map(|x| x.ok()).collect();
                v
            };
            let tx = st.conn.unchecked_transaction()?;
            for (id, old) in rows {
                let next = if old == path {
                    Some(new_path.clone())
                } else {
                    old.strip_prefix(&old_prefix).map(|suffix| format!("{new_prefix}{suffix}"))
                };
                if let Some(next) = next {
                    let leaf = Self::folder_leaf(&next, &delimiter);
                    tx.execute("UPDATE folders SET path=?, name=? WHERE id=?", params![next, leaf, id])?;
                }
            }
            tx.commit()?;
        }
        self.selected.clear();
        self.sync_folder_list().await?;
        Ok(())
    }

    async fn delete_folder(&mut self, path: String) -> Result<()> {
        let delimiter = self.hierarchy_delimiter().await?;
        let prefix = format!("{path}{delimiter}");
        if self.selected == path || self.selected.starts_with(&prefix) {
            let _ = self.select("INBOX").await;
        }
        self.sess().delete(&path).await.map_err(|e| anyhow!(tr!("删除文件夹失败：{e}", "Couldn't delete folder: {e}")))?;
        self.selected.clear();
        self.sync_folder_list().await?;
        Ok(())
    }

    async fn do_op(&mut self, op: Op) -> Result<()> {
        match op {
            op @ (Op::Body { .. } | Op::Flags { .. }) => self.do_light(op).await?,
            Op::Move { from, uids, to, ids } => {
                if uids.is_empty() {
                    return Ok(());
                }
                let exists = {
                    let names: Vec<async_imap::types::Name> = self.sess().list(Some(""), Some(&to)).await?.try_collect().await?;
                    !names.is_empty()
                };
                if !exists {
                    // 没有归档文件夹的邮箱（如 Stalwart 默认）：先建再移
                    self.sess().create(&to).await.map_err(|e| anyhow!(tr!("创建文件夹「{to}」失败：{e}", "Couldn't create folder \"{to}\": {e}")))?;
                    self.sync_folder_list().await?;
                }
                self.select(&from).await?;
                // 分批发：一次几千个 UID 拼成的命令有的服务器会拒收。重试时已经移走的 UID 在原文件夹里不存在，服务器按空操作处理
                for set in uid_sets(&uids) {
                    if self.caps.contains("MOVE") {
                        self.sess().uid_mv(&set, &to).await?;
                    } else {
                        self.sess().uid_copy(&set, &to).await?;
                        let _: Vec<_> = self.sess().uid_store(&set, "+FLAGS.SILENT (\\Deleted)").await?.try_collect().await?;
                        self.expunge(&set, &uids).await?;
                    }
                }
                // 同步目标文件夹，按 Message-ID 对上占位；对不上的（没有 Message-ID）删掉占位，用服务器上的新副本
                if let Some(fid) = self.folder_id_by_path(&to) {
                    if let Some(f) = self.folder_by_id(fid) {
                        self.sync_folder(&f, false).await?;
                    }
                }
                let st = self.ctx.store.lock().unwrap();
                let left: Vec<i64> = ids
                    .iter()
                    .copied()
                    .filter(|id| st.conn.query_row("SELECT uid<0 FROM messages WHERE id=?", [id], |r| r.get::<_, bool>(0)).unwrap_or(false))
                    .collect();
                // 新副本的 UID 一定比本地已有的大，上面的同步已经把它当新邮件拉下来了，占位删掉即可
                if !left.is_empty() {
                    st.delete_messages(&left)?;
                    st.refresh_counts(self.cfg.id)?;
                }
            }
            Op::Delete { path, uids } => {
                if uids.is_empty() {
                    return Ok(());
                }
                self.select(&path).await?;
                for set in uid_sets(&uids) {
                    let _: Vec<_> = self.sess().uid_store(&set, "+FLAGS.SILENT (\\Deleted)").await?.try_collect().await?;
                    self.expunge(&set, &uids).await?;
                }
            }
            Op::FolderCreate { parent, name, reply } => {
                let r = self.create_folder(parent, name).await.map_err(|e| e.to_string());
                let _ = reply.send(r);
            }
            Op::FolderRename { path, name, reply } => {
                let r = self.rename_folder(path, name).await.map_err(|e| e.to_string());
                let _ = reply.send(r);
            }
            Op::FolderDelete { path, reply } => {
                let r = self.delete_folder(path).await.map_err(|e| e.to_string());
                let _ = reply.send(r);
            }
            Op::Empty { path } => {
                if self.select(&path).await?.exists > 0 {
                    let _: Vec<_> = self.sess().uid_store("1:*", "+FLAGS.SILENT (\\Deleted)").await?.try_collect().await?;
                    // 整个文件夹都要清，普通 EXPUNGE 也不会误伤
                    let _: Vec<_> = self.sess().expunge().await?.try_collect().await?;
                }
                // 点清空之后才挪进来的（删除的占位后来对上了 UID）服务器上也清掉了，本地一起删；撤销窗口里的不动
                if let Some(fid) = self.folder_id_by_path(&path) {
                    let st = self.ctx.store.lock().unwrap();
                    let mut q = st.conn.prepare("SELECT id FROM messages WHERE folder_id=? AND uid>0 AND moving=0")?;
                    let ids: Vec<i64> = q.query_map([fid], |r| r.get(0))?.filter_map(|x| x.ok()).collect();
                    drop(q);
                    if !ids.is_empty() {
                        st.delete_messages(&ids)?;
                        st.refresh_counts(self.cfg.id)?;
                        drop(st);
                        crate::commands::notify_changed(&self.ctx);
                    }
                }
            }
            Op::Append { role, raw } => {
                if let Some(f) = self.folder_by_role(role) {
                    let flags = if role == "drafts" { "(\\Seen \\Draft)" } else { "(\\Seen)" };
                    self.sess().append(&f.path, Some(flags), None, &raw).await?;
                    self.sync_folder(&f, false).await?;
                }
            }
            Op::SyncFolder { folder_id } => {
                if let Some(f) = self.folder_by_id(folder_id) {
                    self.sync_folder(&f, false).await?;
                }
            }
            Op::SyncAll => {
                self.sync_folder_list().await?;
                self.full_sync().await?;
            }
        }
        Ok(())
    }

    /// 彻底清除打了删除标记的信。服务器没有 UIDPLUS 时只能用普通 EXPUNGE，它会把整个文件夹里所有带删除标记的都清掉，
    /// 包括用户在别的客户端标了、还没清的：先把那些的标记暂时去掉，清完再标回去
    async fn expunge(&mut self, set: &str, ours: &[u32]) -> Result<()> {
        if self.caps.contains("UIDPLUS") {
            let _: Vec<_> = self.sess().uid_expunge(set).await?.try_collect().await?;
            return Ok(());
        }
        let marked: HashSet<u32> = self.sess().uid_search("DELETED").await?;
        let ours: HashSet<u32> = ours.iter().copied().collect();
        let mut others: Vec<u32> = marked.difference(&ours).copied().collect();
        others.sort_unstable();
        for set in uid_sets(&others) {
            let _: Vec<_> = self.sess().uid_store(&set, "-FLAGS.SILENT (\\Deleted)").await?.try_collect().await?;
        }
        let r: Result<()> = match self.sess().expunge().await {
            Ok(st) => st.try_collect::<Vec<_>>().await.map(|_| ()).map_err(Into::into),
            Err(e) => Err(e.into()),
        };
        // 不管清没清成，都把别处的删除标记还回去
        for set in uid_sets(&others) {
            let _: Vec<_> = self.sess().uid_store(&set, "+FLAGS.SILENT (\\Deleted)").await?.try_collect().await?;
        }
        r?;
        Ok(())
    }

    fn folder_id_by_path(&self, path: &str) -> Option<i64> {
        let st = self.ctx.store.lock().unwrap();
        st.conn.query_row("SELECT id FROM folders WHERE account_id=? AND path=?", params![self.cfg.id, path], |r| r.get(0)).ok()
    }
}

enum Wake {
    NewMail,
    Timeout,
    Op,
    Stop,
}

/// 保存正文：原始邮件写 .eml 文件，文本进数据库和全文索引
/// UID 列表转成 IMAP 的集合写法：排序去重，连续的并成 a:b，每批最多 400 段（命令长度有限）
fn uid_sets(uids: &[u32]) -> Vec<String> {
    let mut v = uids.to_vec();
    v.sort_unstable();
    v.dedup();
    let mut ranges: Vec<(u32, u32)> = Vec::new();
    for u in v {
        match ranges.last_mut() {
            Some((_, b)) if *b + 1 == u => *b = u,
            _ => ranges.push((u, u)),
        }
    }
    ranges
        .chunks(400)
        .map(|c| c.iter().map(|(a, b)| if a == b { a.to_string() } else { format!("{a}:{b}") }).collect::<Vec<_>>().join(","))
        .collect()
}

pub fn store_body(ctx: &Ctx, msg_id: i64, raw: &[u8]) -> Result<()> {
    let full = mime::parse_full(raw);
    let st: std::sync::MutexGuard<'_, Store> = ctx.store.lock().unwrap();
    std::fs::write(st.eml_path(msg_id), raw)?;
    let visible: Vec<&mime::AttInfo> = full.atts.iter().filter(|a| !a.inline).collect();
    let snip = text::snippet(&text::strip_quotes(&full.text), 160);
    st.conn.execute(
        "UPDATE messages SET has_body=1, body_text=?, body_html=?, att_json=?, snippet=?, has_att=? WHERE id=?",
        params![full.text, full.html, serde_json::to_string(&full.atts)?, snip, !visible.is_empty(), msg_id],
    )?;
    let (subject, people): (String, String) = st.conn.query_row(
        "SELECT subject, from_name || ' ' || from_addr || ' ' || to_json FROM messages WHERE id=?",
        [msg_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let body: String = full.text.chars().take(20000).collect();
    st.fts_put(msg_id, &subject, &people, &body)?;
    Ok(())
}

#[cfg(test)]
mod readable_tests {
    #[test]
    fn bytes_to_text() {
        let e = "io: Error(Error { input: [85, 110, 97, 118, 97, 105, 108, 97, 98, 108, 101, 46, 32, 49, 53, 13, 10, 42, 32, 66, 89, 69], code: Tag })";
        assert_eq!(super::readable(e), "io: 服务器回了无法识别的内容：Unavailable. 15");
        assert_eq!(super::readable("connection lost"), "connection lost");
    }
}

#[cfg(test)]
mod uid_set_tests {
    use super::uid_sets;

    #[test]
    fn ranges_and_batches() {
        assert_eq!(uid_sets(&[5, 3, 4, 9, 1, 3]), vec!["1,3:5,9"]);
        assert!(uid_sets(&[]).is_empty());
        // 5000 个不连续的 UID：400 段一批
        let spread: Vec<u32> = (0..5000).map(|i| i * 2).collect();
        let sets = uid_sets(&spread);
        assert_eq!(sets.len(), 13);
        assert_eq!(sets[0].split(',').count(), 400);
        // 连续的 5000 个只要一段
        let dense: Vec<u32> = (1..=5000).collect();
        assert_eq!(uid_sets(&dense), vec!["1:5000"]);
    }
}

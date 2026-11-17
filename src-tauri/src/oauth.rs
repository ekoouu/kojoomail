//! 一键登录：OAuth2 授权码 + PKCE。在系统浏览器里登录，回调到本机回环地址，拿到长期授权（refresh token）。
//! 长期授权和密码一样只存凭据管理器；短期令牌（约 1 小时）只放内存，过期前自动换新。
//! 收信用 IMAP XOAUTH2，发信用 SMTP XOAUTH2；Outlook 发信走 Graph（见 graph.rs），登录时一并同意 Mail.Send。QQ / 网易 / iCloud 不对第三方客户端开放 OAuth，只能用授权码。

use crate::secret;
use anyhow::{anyhow, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

/// 登录凭证：密码/授权码，或 OAuth 短期令牌
pub enum Auth {
    Password(String),
    Bearer(String),
}

struct Spec {
    auth_url: &'static str,
    token_url: &'static str,
    scope: &'static str,
    /// 登录时一并请用户同意、之后另换令牌的权限（微软一个令牌只对应一个服务：Graph 的发信权限要单独换）
    consent: &'static str,
    /// 回调地址里的主机名（谷歌用 127.0.0.1，微软桌面应用登记的是 localhost）
    host: &'static str,
    extra: &'static [(&'static str, &'static str)],
}

fn spec(provider: &str) -> Option<Spec> {
    match provider {
        "gmail" => Some(Spec {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
            token_url: "https://oauth2.googleapis.com/token",
            scope: "https://mail.google.com/ openid email",
            consent: "",
            host: "127.0.0.1",
            // 每次都要长期授权（谷歌只在用户同意时才给 refresh token）
            extra: &[("access_type", "offline"), ("prompt", "consent")],
        }),
        "outlook" => Some(Spec {
            auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            scope: "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email",
            consent: "https://graph.microsoft.com/Mail.Send",
            host: "localhost",
            extra: &[("prompt", "select_account")],
        }),
        _ => None,
    }
}

/// 客户端 ID（打包时写入；运行时的环境变量优先，方便测试）。谷歌桌面应用还要一个不算机密的 client secret
fn client(provider: &str) -> Option<(String, Option<String>)> {
    let pick = |name: &str, built: Option<&'static str>| std::env::var(name).ok().filter(|v| !v.is_empty()).or(built.filter(|v| !v.is_empty()).map(String::from));
    match provider {
        "gmail" => Some((
            pick("KOJOOMAIL_GOOGLE_CLIENT_ID", option_env!("KOJOOMAIL_GOOGLE_CLIENT_ID"))?,
            pick("KOJOOMAIL_GOOGLE_CLIENT_SECRET", option_env!("KOJOOMAIL_GOOGLE_CLIENT_SECRET")),
        )),
        "outlook" => Some((pick("KOJOOMAIL_MS_CLIENT_ID", option_env!("KOJOOMAIL_MS_CLIENT_ID"))?, None)),
        _ => None,
    }
}

pub fn available(provider: &str) -> bool {
    spec(provider).is_some() && client(provider).is_some()
}

#[derive(Clone)]
pub struct Grant {
    pub provider: String,
    pub email: String,
    pub refresh: String,
    pub access: String,
    pub expires: Instant,
    /// 登录服务器说实际给了哪些权限，空格分隔；没返回就是 None
    pub scope: Option<String>,
}

/// 授权结果先放这里，前端拿票据来添加账号（长期授权不经过界面）
static PENDING: Mutex<Option<HashMap<String, (Grant, Instant)>>> = Mutex::new(None);
/// 内存里的短期令牌：(账号 id, 是否 Graph 令牌) → (令牌, 过期时间)
static TOKENS: Mutex<Option<HashMap<(i64, bool), (String, Instant)>>> = Mutex::new(None);
/// Outlook 发信用的 Graph 令牌范围（用长期授权换）
const GRAPH_SCOPE: &str = "https://graph.microsoft.com/Mail.Send offline_access";
/// 同一时间只有一个浏览器登录流程；开新的会取消旧的
static FLOW: Mutex<Option<Arc<Notify>>> = Mutex::new(None);
static TICKET_SEQ: AtomicU64 = AtomicU64::new(1);

fn rand_b64(n: usize) -> String {
    let mut b = vec![0u8; n];
    getrandom::fill(&mut b).expect("系统随机数不可用");
    B64.encode(b)
}

pub fn cancel() {
    if let Some(n) = FLOW.lock().unwrap().take() {
        n.notify_one();
    }
}

/// 打开浏览器登录，等回调，换令牌，返回票据和邮箱地址
pub async fn authorize(http: &reqwest::Client, provider: &str, hint: &str) -> Result<(String, String)> {
    let sp = spec(provider).ok_or_else(|| anyhow!("{}", crate::i18n::t("这个邮箱不支持一键登录", "This mailbox doesn't support one-click sign-in")))?;
    let (cid, csecret) = client(provider).ok_or_else(|| if crate::i18n::en() { anyhow!("This build doesn't support one-click sign-in for {} accounts", if provider == "gmail" { "Google" } else { "Microsoft" }) } else { anyhow!("这个版本暂时不支持{}账号一键登录", if provider == "gmail" { "谷歌" } else { "微软" }) })?;
    let open = |u: &str| crate::os::open_url(u).map_err(anyhow::Error::from);
    authorize_with(http, provider, &sp, &cid, csecret.as_deref(), hint, open).await
}

/// 拆出来方便测试：打开浏览器这一步由调用方给
async fn authorize_with(http: &reqwest::Client, provider: &str, sp: &Spec, cid: &str, csecret: Option<&str>, hint: &str, open: impl FnOnce(&str) -> Result<()>) -> Result<(String, String)> {
    let v4 = TcpListener::bind("127.0.0.1:0").await?;
    let port = v4.local_addr()?.port();
    // 浏览器把 localhost 解析成 IPv6 时也能接到
    let v6 = TcpListener::bind(("::1", port)).await.ok();
    let redirect = format!("http://{}:{port}", sp.host);
    let verifier = rand_b64(32);
    let challenge = B64.encode(Sha256::digest(verifier.as_bytes()));
    let state = rand_b64(16);
    let scope = if sp.consent.is_empty() { sp.scope.to_string() } else { format!("{} {}", sp.scope, sp.consent) };
    let mut params: Vec<(&str, &str)> = vec![
        ("client_id", cid),
        ("redirect_uri", redirect.as_str()),
        ("response_type", "code"),
        ("scope", scope.as_str()),
        ("state", state.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
    ];
    params.extend_from_slice(sp.extra);
    if !hint.is_empty() {
        params.push(("login_hint", hint));
    }
    let url = url::Url::parse_with_params(sp.auth_url, &params)?;

    let stop = Arc::new(Notify::new());
    {
        let mut f = FLOW.lock().unwrap();
        if let Some(old) = f.replace(stop.clone()) {
            old.notify_one();
        }
    }
    if let Err(x) = open(url.as_str()) {
        FLOW.lock().unwrap().take();
        return Err(x);
    }

    // 每个连接单独处理：浏览器预连接的空闲套接字、本机其他程序乱发的请求都挡不住真正的回调
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Result<String>>();
    let wait = async {
        loop {
            let accepted = tokio::select! {
                got = rx.recv() => return got.unwrap_or_else(|| Err(anyhow!("{}", crate::i18n::t("登录中断，请重试", "Sign-in was interrupted. Please try again.")))),
                r = v4.accept() => r,
                r = async { match &v6 { Some(l) => l.accept().await, None => std::future::pending().await } } => r,
            };
            let Ok((sock, _)) = accepted else {
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            };
            let (tx, state) = (tx.clone(), state.clone());
            tokio::spawn(async move {
                if let Some(r) = callback(sock, &state).await {
                    let _ = tx.send(r);
                }
            });
        }
    };
    let code = tokio::select! {
        r = wait => r,
        _ = stop.notified() => Err(anyhow!("{}", crate::i18n::t("已取消", "Cancelled"))),
        _ = tokio::time::sleep(Duration::from_secs(900)) => Err(anyhow!("{}", crate::i18n::t("等了 15 分钟没有完成登录，请重试", "Sign-in wasn't completed within 15 minutes. Please try again."))),
    };
    {
        let mut f = FLOW.lock().unwrap();
        if f.as_ref().is_some_and(|x| Arc::ptr_eq(x, &stop)) {
            *f = None;
        }
    }
    let code = code?;

    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("client_id", cid),
        ("code_verifier", verifier.as_str()),
    ];
    if let Some(s) = csecret {
        form.push(("client_secret", s));
    }
    // 同意了两个服务的权限时，换令牌要指明先要哪个（收信这个）
    if !sp.consent.is_empty() {
        form.push(("scope", sp.scope));
    }
    let t = token_call(http, sp.token_url, &form).await.map_err(|e| anyhow!("{}", e.msg))?;
    let refresh = t.refresh.ok_or_else(|| anyhow!("{}", crate::i18n::t("没有拿到长期授权，请重新登录一次", "Didn't get lasting access. Please sign in again.")))?;
    let email = t.id_token.as_deref().and_then(email_from_id_token).ok_or_else(|| anyhow!("{}", crate::i18n::t("没有拿到邮箱地址，请重试", "Couldn't get the email address. Please try again.")))?;
    let ticket = format!("t{}-{}", TICKET_SEQ.fetch_add(1, Ordering::Relaxed), rand_b64(8));
    let mut p = PENDING.lock().unwrap();
    let map = p.get_or_insert_with(HashMap::new);
    map.retain(|_, (_, at)| at.elapsed() < Duration::from_secs(1800));
    map.insert(ticket.clone(), (Grant { provider: provider.into(), email: email.clone(), refresh, access: t.access, expires: t.expires, scope: t.scope.clone() }, Instant::now()));
    Ok((ticket, email))
}

/// 处理一次回调请求：state 对得上才算数（返回 Some）；对不上的（别的程序、旧页面）回个页面就不管，继续等
async fn callback(mut sock: TcpStream, state: &str) -> Option<Result<String>> {
    let mut buf = vec![0u8; 8192];
    let mut n = 0;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while n < buf.len() {
        let k = match tokio::time::timeout_at(deadline, sock.read(&mut buf[n..])).await {
            Ok(Ok(k)) if k > 0 => k,
            _ => break,
        };
        n += k;
        if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let req = String::from_utf8_lossy(&buf[..n]).into_owned();
    let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
    let q: HashMap<String, String> = url::Url::parse(&format!("http://x{path}")).map(|u| u.query_pairs().into_owned().collect()).unwrap_or_default();
    if !q.contains_key("code") && !q.contains_key("error") {
        // 浏览器顺带请求的 favicon 之类
        let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
        return None;
    }
    let mine = q.get("state").map(String::as_str) == Some(state);
    let page = if mine && q.contains_key("code") { crate::i18n::t("已授权，可以关掉这个页面，回到 Kojoo Mail。", "Authorized. You can close this page and go back to Kojoo Mail.") } else { crate::i18n::t("没有完成授权，请回到 Kojoo Mail 重试。", "Authorization wasn't completed. Go back to Kojoo Mail and try again.") };
    let body = format!("<!doctype html><meta charset=utf-8><title>Kojoo Mail</title><body style=\"font:15px/1.6 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:90vh;color:#0f1c2a\"><p>{page}</p>");
    let head = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = sock.write_all(head.as_bytes()).await;
    let _ = sock.write_all(body.as_bytes()).await;
    let _ = sock.shutdown().await;
    if !mine {
        return None;
    }
    if let Some(err) = q.get("error") {
        return Some(Err(match err.as_str() {
            "access_denied" => anyhow!("{}", crate::i18n::t("在浏览器里取消了授权", "Authorization was cancelled in the browser")),
            _ => anyhow!(tr!("授权失败：{}", "Authorization failed: {}", q.get("error_description").unwrap_or(err))),
        }));
    }
    Some(Ok(q["code"].clone()))
}

/// 谷歌授权页上 Gmail 那一项可以不勾，不勾时只拿到登录身份，令牌连收信会被拒。
/// 只有 Gmail、且登录服务器返回了权限清单、清单里没有收信权限时才算缺；别的服务商、没返回清单都不算
pub fn missing_mail_scope(provider: &str, scope: Option<&str>) -> bool {
    provider == "gmail" && scope.is_some_and(|s| !s.split_whitespace().any(|x| x == "https://mail.google.com/"))
}

/// 看一眼票据（添加账号验证通过之前不作废，验证失败不用重新授权）
pub fn peek(ticket: &str) -> Option<Grant> {
    PENDING.lock().unwrap().as_ref()?.get(ticket).map(|x| x.0.clone())
}

pub fn take(ticket: &str) -> Option<Grant> {
    PENDING.lock().unwrap().as_mut()?.remove(ticket).map(|x| x.0)
}

/// 添加账号 / 重新登录后记下收信令牌，接下来的首次连接不用再换。这个账号旧的 Graph 令牌一并丢掉：
/// 重新登录往往就是为了补同意发信权限，旧的不能再用
pub fn remember(id: i64, access: String, expires: Instant) {
    let mut g = TOKENS.lock().unwrap();
    let m = g.get_or_insert_with(HashMap::new);
    m.remove(&(id, true));
    m.insert((id, false), (access, expires));
}

/// 添加账号时已经换到的 Graph 令牌，留给第一次发信用
pub fn remember_graph(id: i64, access: String, expires: Instant) {
    TOKENS.lock().unwrap().get_or_insert_with(HashMap::new).insert((id, true), (access, expires));
}

pub fn forget(id: i64) {
    if let Some(m) = TOKENS.lock().unwrap().as_mut() {
        m.remove(&(id, false));
        m.remove(&(id, true));
    }
}

pub struct TokenErr {
    /// 授权被撤销或失效（要重新登录）；false 是网络问题
    pub auth: bool,
    pub msg: String,
}

struct Tokens {
    access: String,
    refresh: Option<String>,
    id_token: Option<String>,
    expires: Instant,
    scope: Option<String>,
}

async fn token_call(http: &reqwest::Client, url: &str, form: &[(&str, &str)]) -> Result<Tokens, TokenErr> {
    let net = |m: String| TokenErr { auth: false, msg: m };
    let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(form).finish();
    let r = http
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| net(tr!("连不上登录服务器：{e}", "Can't reach the sign-in server: {e}")))?;
    let status = r.status();
    let v: serde_json::Value = r.json().await.map_err(|e| net(tr!("登录服务器返回的内容看不懂：{e}", "Unexpected response from the sign-in server: {e}")))?;
    if !status.is_success() {
        let code = v["error"].as_str().unwrap_or("");
        let desc = v["error_description"].as_str().unwrap_or(code);
        // 4xx 带错误码（invalid_grant 被撤销/过期、invalid_client 配置不对、要重新同意……）都得重新登录；
        // 只有限流、服务器错误、temporarily_unavailable 算暂时的，过会儿再试
        let auth = status.is_client_error() && status.as_u16() != 429 && !code.is_empty() && code != "temporarily_unavailable";
        return Err(TokenErr { auth, msg: if auth { tr!("授权已失效，请重新登录（{desc}）", "Authorization has expired. Please sign in again ({desc})") } else { tr!("换取令牌失败（{status}）：{desc}", "Couldn't get a token ({status}): {desc}") } });
    }
    let access = v["access_token"].as_str().ok_or_else(|| net(crate::i18n::t("登录服务器没有返回令牌", "The sign-in server didn't return a token").into()))?.to_string();
    let secs = v["expires_in"].as_u64().unwrap_or(3600);
    Ok(Tokens {
        access,
        refresh: v["refresh_token"].as_str().map(String::from),
        id_token: v["id_token"].as_str().map(String::from),
        expires: Instant::now() + Duration::from_secs(secs.saturating_sub(120).max(60)),
        scope: v["scope"].as_str().map(String::from),
    })
}

/// id_token 是登录服务器经 TLS 直接给的，这里只读里面的邮箱，不另做签名校验
fn email_from_id_token(t: &str) -> Option<String> {
    let payload = t.split('.').nth(1)?;
    let raw = B64.decode(payload.trim_end_matches('=')).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    let e = v["email"].as_str().or_else(|| v["preferred_username"].as_str())?;
    e.contains('@').then(|| e.trim().to_lowercase())
}

/// 取一个能用的短期令牌：内存里没过期就直接用，否则用长期授权换新（微软会顺带换新的长期授权，要存回去）
pub async fn access_token(http: &reqwest::Client, id: i64, provider: &str) -> Result<String, TokenErr> {
    token_for(http, id, provider, false).await
}

/// Outlook 发信用的 Graph 令牌
pub async fn graph_token(http: &reqwest::Client, id: i64) -> Result<String, TokenErr> {
    token_for(http, id, "outlook", true).await
}

/// 添加账号时（还没有账号 id）用刚拿到的长期授权试换 Graph 令牌，确认用户同意了发信权限。返回令牌和过期时间
pub async fn graph_token_from(http: &reqwest::Client, refresh: &str) -> Result<(String, Instant), TokenErr> {
    let (sp, cid, csecret) = setup("outlook")?;
    let t = token_call(http, sp.token_url, &refresh_form("outlook", &sp, &cid, csecret.as_deref(), refresh, true)).await?;
    Ok((t.access, t.expires))
}

fn setup(provider: &str) -> Result<(Spec, String, Option<String>), TokenErr> {
    let sp = spec(provider).ok_or_else(|| TokenErr { auth: true, msg: crate::i18n::t("这个邮箱不支持一键登录", "This mailbox doesn't support one-click sign-in").into() })?;
    let (cid, csecret) = client(provider).ok_or_else(|| TokenErr { auth: true, msg: crate::i18n::t("这个版本没有配置一键登录", "One-click sign-in isn't configured in this build").into() })?;
    Ok((sp, cid, csecret))
}

/// 用长期授权换短期令牌的表单。微软一个令牌只对应一个服务，要指明换收信的还是 Graph 发信的
fn refresh_form<'a>(provider: &str, sp: &Spec, cid: &'a str, csecret: Option<&'a str>, rt: &'a str, graph: bool) -> Vec<(&'a str, &'a str)> {
    let mut form = vec![("grant_type", "refresh_token"), ("refresh_token", rt), ("client_id", cid)];
    if let Some(s) = csecret {
        form.push(("client_secret", s));
    }
    if provider == "outlook" {
        form.push(("scope", if graph { GRAPH_SCOPE } else { sp.scope }));
    }
    form
}

async fn token_for(http: &reqwest::Client, id: i64, provider: &str, graph: bool) -> Result<String, TokenErr> {
    if let Some((t, exp)) = TOKENS.lock().unwrap().as_ref().and_then(|m| m.get(&(id, graph)).cloned()) {
        if Instant::now() < exp {
            return Ok(t);
        }
    }
    let (sp, cid, csecret) = setup(provider)?;
    let rt = tokio::task::spawn_blocking(move || secret::read(&secret::account_key(id)))
        .await
        .unwrap_or_else(|e| Err(e.to_string()))
        .map_err(|e| TokenErr { auth: false, msg: tr!("暂时读不到系统里保存的登录授权：{e}", "Couldn't read the saved sign-in authorization from the system just now: {e}") })?
        .ok_or_else(|| TokenErr { auth: true, msg: crate::i18n::t("没有找到登录授权，请重新登录", "No sign-in authorization found. Please sign in again.").into() })?;
    let t = token_call(http, sp.token_url, &refresh_form(provider, &sp, &cid, csecret.as_deref(), &rt, graph)).await?;
    let key = secret::account_key(id);
    // 换令牌期间账号被删了、或者用户刚重新登录过（凭据已不是刚才那个）：别拿旧的覆盖回去
    // （这一下没读到不算变了：照常把新的长期授权存下来，否则微软换过的授权就丢了）
    if matches!(secret::read(&key), Ok(v) if v.as_deref() != Some(rt.as_str())) {
        return Ok(t.access);
    }
    if let Some(new_rt) = t.refresh.as_deref().filter(|r| *r != rt) {
        let _ = secret::set(&key, new_rt);
    }
    TOKENS.lock().unwrap().get_or_insert_with(HashMap::new).insert((id, graph), (t.access.clone(), t.expires));
    Ok(t.access)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_token_email() {
        let payload = B64.encode(br#"{"iss":"x","email":"Someone@Gmail.com"}"#);
        assert_eq!(email_from_id_token(&format!("h.{payload}.s")).as_deref(), Some("someone@gmail.com"));
        let ms = B64.encode(br#"{"preferred_username":"me@outlook.com"}"#);
        assert_eq!(email_from_id_token(&format!("h.{ms}.s")).as_deref(), Some("me@outlook.com"));
        assert_eq!(email_from_id_token("garbage"), None);
    }

    #[test]
    fn mail_scope_check() {
        assert!(missing_mail_scope("gmail", Some("openid https://www.googleapis.com/auth/userinfo.email")));
        assert!(!missing_mail_scope("gmail", Some("https://www.googleapis.com/auth/userinfo.email https://mail.google.com/ openid")));
        assert!(!missing_mail_scope("gmail", None));
        assert!(!missing_mail_scope("outlook", Some("openid")));
    }

    /// 假的登录服务器：/authorize 直接 302 回本机回调（模拟用户点了同意或拒绝），/token 校验 PKCE 后发令牌
    async fn mock_server(deny: bool, bad_state: bool) -> String {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        let challenge = Arc::new(Mutex::new(String::new()));
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = l.accept().await.unwrap();
                let challenge = challenge.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 16384];
                    let mut n = 0;
                    loop {
                        let k = sock.read(&mut buf[n..]).await.unwrap();
                        n += k;
                        let t = String::from_utf8_lossy(&buf[..n]).to_string();
                        if let Some(i) = t.find("\r\n\r\n") {
                            let len = t.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                            if n >= i + 4 + len {
                                break;
                            }
                        }
                        if k == 0 {
                            break;
                        }
                    }
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req.split_whitespace().nth(1).unwrap().to_string();
                    let u = url::Url::parse(&format!("http://x{path}")).unwrap();
                    let resp = if u.path() == "/authorize" {
                        let q: HashMap<String, String> = u.query_pairs().into_owned().collect();
                        assert_eq!(q["code_challenge_method"], "S256");
                        assert_eq!(q["client_id"], "cid-1");
                        *challenge.lock().unwrap() = q["code_challenge"].clone();
                        let state = if bad_state { "evil".to_string() } else { q["state"].clone() };
                        let loc = if deny {
                            format!("{}/?error=access_denied&state={state}", q["redirect_uri"])
                        } else {
                            format!("{}/?code=CODE123&state={state}", q["redirect_uri"])
                        };
                        format!("HTTP/1.1 302 Found\r\nLocation: {loc}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    } else {
                        let body = req.split("\r\n\r\n").nth(1).unwrap_or("");
                        let f: HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes()).into_owned().collect();
                        let pkce_ok = f.get("code_verifier").is_some_and(|v| B64.encode(Sha256::digest(v.as_bytes())) == *challenge.lock().unwrap());
                        let ok = f.get("grant_type").map(String::as_str) == Some("authorization_code") && f.get("code").map(String::as_str) == Some("CODE123") && pkce_ok && f.get("client_secret").map(String::as_str) == Some("sec-1");
                        let idt = format!("h.{}.s", B64.encode(br#"{"email":"Me@Gmail.com"}"#));
                        let (st, j) = if ok {
                            ("200 OK", serde_json::json!({"access_token":"AT","refresh_token":"RT","expires_in":3600,"id_token":idt}).to_string())
                        } else {
                            ("400 Bad Request", r#"{"error":"invalid_grant","error_description":"bad"}"#.to_string())
                        };
                        format!("HTTP/1.1 {st}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{j}", j.len())
                    };
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        base
    }

    fn mock_spec(base: &str) -> Spec {
        Spec {
            auth_url: Box::leak(format!("{base}/authorize").into_boxed_str()),
            token_url: Box::leak(format!("{base}/token").into_boxed_str()),
            scope: "s",
            consent: "",
            host: "127.0.0.1",
            extra: &[("access_type", "offline")],
        }
    }

    /// 「浏览器」：请求授权页，跟着 302 回到本机回调
    fn fake_browser(u: &str) -> Result<()> {
        let u = u.to_string();
        tokio::spawn(async move {
            let _ = reqwest::Client::new().get(u).send().await;
        });
        Ok(())
    }

    // 登录流程同一时间只能有一个（新的会取消旧的），这几个测试要排队跑
    static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn full_flow_with_pkce() {
        let _g = SERIAL.lock().await;
        let base = mock_server(false, false).await;
        let http = reqwest::Client::new();
        let (ticket, email) = authorize_with(&http, "gmail", &mock_spec(&base), "cid-1", Some("sec-1"), "me@gmail.com", fake_browser).await.unwrap();
        assert_eq!(email, "me@gmail.com");
        let g = take(&ticket).unwrap();
        assert_eq!((g.refresh.as_str(), g.access.as_str(), g.provider.as_str()), ("RT", "AT", "gmail"));
        assert!(take(&ticket).is_none(), "票据只能用一次");
    }

    #[tokio::test]
    async fn denied_and_forged_state() {
        let _g = SERIAL.lock().await;
        let http = reqwest::Client::new();
        let base = mock_server(true, false).await;
        let e = authorize_with(&http, "gmail", &mock_spec(&base), "cid-1", Some("sec-1"), "", fake_browser).await.unwrap_err();
        assert!(e.to_string().contains("取消了授权"), "{e}");
        // state 对不上的回调（伪造的）被忽略，登录继续等；这里等一会儿再取消
        let base = mock_server(false, true).await;
        let t = tokio::spawn(async move { authorize_with(&http, "gmail", &mock_spec(&base), "cid-1", Some("sec-1"), "", fake_browser).await });
        tokio::time::sleep(Duration::from_millis(800)).await;
        cancel();
        assert_eq!(t.await.unwrap().unwrap_err().to_string(), "已取消");
    }

    #[tokio::test]
    async fn cancel_stops_waiting() {
        let _g = SERIAL.lock().await;
        let http = reqwest::Client::new();
        let base = mock_server(false, false).await;
        // 浏览器什么都不做（用户没去登录），然后在界面上点了取消
        let t = tokio::spawn(async move { authorize_with(&http, "gmail", &mock_spec(&base), "cid-1", None, "", |_| Ok(())).await });
        tokio::time::sleep(Duration::from_millis(200)).await;
        cancel();
        let e = t.await.unwrap().unwrap_err();
        assert_eq!(e.to_string(), "已取消");
    }

    #[tokio::test]
    async fn invalid_grant_is_auth_error() {
        let base = mock_server(false, false).await;
        let e = token_call(&reqwest::Client::new(), &format!("{base}/token"), &[("grant_type", "refresh_token")]).await.err().unwrap();
        assert!(e.auth && e.msg.contains("重新登录"), "{}", e.msg);
        let e = token_call(&reqwest::Client::new(), "http://127.0.0.1:1/token", &[]).await.err().unwrap();
        assert!(!e.auth, "连不上是网络问题，不是授权失效");
    }

    /// 真服务器上的 XOAUTH2：假令牌应当被当成「授权失效」，而不是卡住或当成网络问题（要能连上 Gmail / Outlook）
    #[tokio::test]
    #[ignore]
    async fn real_servers_reject_bad_token() {
        for (h, p) in [("imap.gmail.com", 993), ("outlook.office365.com", 993)] {
            match crate::mailbox::connect(h, p, "nobody@example.com", &Auth::Bearer("bad-token".into())).await {
                Ok(_) => panic!("{h} 居然接受了假令牌"),
                Err(e) => assert!(e.auth, "{h}: {}", e.msg),
            }
        }
        for (h, p, tls) in [("smtp.gmail.com", 465, true), ("smtp.office365.com", 587, false)] {
            let c = crate::smtp::SmtpCfg { host: h.into(), port: p, tls, username: "nobody@example.com".into(), password: "bad-token".into(), oauth: true };
            let e = crate::smtp::test(&c).await.unwrap_err().to_string();
            assert!(crate::smtp::is_auth_fail(&e), "{h}: {e}");
            println!("{h}: {e}");
        }
    }

    #[test]
    fn pkce_challenge_is_url_safe() {
        let v = rand_b64(32);
        assert_eq!(v.len(), 43);
        let c = B64.encode(Sha256::digest(v.as_bytes()));
        assert!(c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'));
    }
}

//! 连邮件服务器：系统设置了代理（比如 Clash 的 127.0.0.1:7890）就走代理的 HTTP CONNECT 隧道，否则直连。
//! 国内访问 Gmail 要靠代理；代理软件按规则分流，国内邮箱照样直连。代理没开（连不上）时退回直连。
//! 设置里可改成不用代理，或自定义代理地址（自定义时代理连不上直接报错，不退回直连）。

use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// 代理模式：跟随系统 / 不用代理 / 自定义 HTTP 代理（主机:端口）
#[derive(Clone, PartialEq, Debug)]
enum Mode {
    System,
    Off,
    Custom(String),
}

static MODE: std::sync::RwLock<Mode> = std::sync::RwLock::new(Mode::System);

/// 用户填的代理地址整理成 主机:端口；不是 HTTP 代理或格式不对返回 None
pub fn clean_addr(v: &str) -> Option<String> {
    let v = v.trim();
    let v = v.strip_prefix("http://").unwrap_or(v).trim_end_matches('/');
    if v.contains("://") {
        return None;
    }
    let (host, port) = v.rsplit_once(':')?;
    let port: u16 = port.parse().ok().filter(|p| *p > 0)?;
    (!host.is_empty() && !host.chars().any(char::is_whitespace)).then(|| format!("{host}:{port}"))
}

/// 按设置切换代理模式（读设置、存设置时调用）
pub fn configure(mode: &str, addr: &str) {
    let m = match mode {
        "off" => Mode::Off,
        "custom" => match clean_addr(addr) {
            Some(a) => Mode::Custom(a),
            None => Mode::System,
        },
        _ => Mode::System,
    };
    *MODE.write().unwrap() = m;
}

/// 这次连接走哪个代理：返回（代理地址, 是否严格——连不上就报错、不退回直连）
fn pick(mode: &Mode, sys: impl FnOnce() -> Option<(String, Vec<String>)>, host: &str) -> Option<(String, bool)> {
    match mode {
        Mode::Off => None,
        Mode::Custom(a) => {
            let local: Vec<String> = ["<local>", "localhost", "127.*"].iter().map(|s| s.to_string()).collect();
            (!bypassed(host, &local)).then(|| (a.clone(), true))
        }
        Mode::System => sys().filter(|(_, b)| !bypassed(host, b)).map(|(p, _)| (p, false)),
    }
}

/// 系统代理地址和不走代理的名单（Windows「设置 → 网络 → 代理」，读注册表）
#[cfg(windows)]
fn system_proxy() -> Option<(String, Vec<String>)> {
    let k = windows_registry::CURRENT_USER.open(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings").ok()?;
    if k.get_u32("ProxyEnable").ok()? == 0 {
        return None;
    }
    let server = parse_server(&k.get_string("ProxyServer").ok()?)?;
    let bypass = k.get_string("ProxyOverride").unwrap_or_default().split(';').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
    Some((server, bypass))
}

/// macOS「系统设置 → 网络 → 代理」（ClashX 等设成系统代理时在这里），用 scutil --proxy 读
#[cfg(target_os = "macos")]
fn system_proxy() -> Option<(String, Vec<String>)> {
    use std::sync::Mutex;
    use std::time::Instant;
    type Cached = Option<(Instant, Option<(String, Vec<String>)>)>;
    static CACHE: Mutex<Cached> = Mutex::new(None);
    if let Some((at, v)) = CACHE.lock().unwrap().as_ref() {
        if at.elapsed() < Duration::from_secs(30) {
            return v.clone();
        }
    }
    let v = std::process::Command::new("scutil").arg("--proxy").output().ok().and_then(|o| parse_scutil(&String::from_utf8_lossy(&o.stdout)));
    *CACHE.lock().unwrap() = Some((Instant::now(), v.clone()));
    v
}

#[cfg(not(any(windows, target_os = "macos")))]
fn system_proxy() -> Option<(String, Vec<String>)> {
    None
}

/// scutil --proxy 的输出：优先 HTTPS 代理，没有再用 HTTP 代理；ExceptionsList 是不走代理的名单
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_scutil(t: &str) -> Option<(String, Vec<String>)> {
    let val = |k: &str| t.lines().find_map(|l| l.trim().strip_prefix(k).and_then(|r| r.trim_start().strip_prefix(':')).map(|v| v.trim().to_string()));
    let pick = |p: &str| (val(&format!("{p}Enable")).as_deref() == Some("1")).then(|| Some(format!("{}:{}", val(&format!("{p}Proxy"))?, val(&format!("{p}Port"))?))).flatten();
    let server = pick("HTTPS").or_else(|| pick("HTTP"))?;
    let mut bypass = Vec::new();
    // 「不对简单主机名使用代理」：和 Windows 的 <local> 一个意思
    if val("ExcludeSimpleHostnames").as_deref() == Some("1") {
        bypass.push("<local>".to_string());
    }
    let mut inside = false;
    for l in t.lines() {
        let l = l.trim();
        if l.starts_with("ExceptionsList") {
            inside = true;
        } else if inside && l.starts_with('}') {
            break;
        } else if inside {
            if let Some((_, v)) = l.split_once(':') {
                bypass.push(v.trim().to_lowercase());
            }
        }
    }
    Some((server, bypass))
}

/// "127.0.0.1:7890" 或 "http=…;https=…;socks=…"：取 HTTPS 的，没有就取 HTTP 的（只有 SOCKS 时不用）
fn parse_server(v: &str) -> Option<String> {
    let v = v.trim();
    let pick = if v.contains('=') {
        let part = |name: &str| v.split(';').find_map(|p| p.trim().strip_prefix(name).map(|x| x.trim().to_string()));
        part("https=").or_else(|| part("http="))?
    } else {
        v.to_string()
    };
    let pick = pick.trim_start_matches("http://").trim_end_matches('/').to_string();
    (!pick.is_empty() && pick.contains(':')).then_some(pick)
}

fn bypassed(host: &str, list: &[String]) -> bool {
    let h = host.to_lowercase();
    list.iter().any(|p| {
        if p == "<local>" {
            return !h.contains('.');
        }
        if let Some(hit) = in_cidr(&h, p) {
            return hit;
        }
        match p.split_once('*') {
            None => *p == h,
            Some((a, b)) => h.len() >= a.len() + b.len() && h.starts_with(a) && h.ends_with(b),
        }
    })
}

/// 连上 host:port，返回可以直接在上面跑 TLS 的 TCP 连接，以及是不是真的经过了代理
pub async fn dial(host: &str, port: u16) -> Result<(TcpStream, bool), String> {
    let mode = MODE.read().unwrap().clone();
    dial_by(pick(&mode, system_proxy, host), host, port).await
}

/// via：（代理地址, 是否严格）。严格时代理连不上或拒绝都直接报错，不退回直连
async fn dial_by(via: Option<(String, bool)>, host: &str, port: u16) -> Result<(TcpStream, bool), String> {
    if let Some((proxy, strict)) = via {
        if let Ok(Ok(s)) = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(proxy.as_str())).await {
            let first = match tokio::time::timeout(Duration::from_secs(20), tunnel(s, host, port)).await {
                Ok(Ok(s)) => return Ok((s, true)),
                Ok(Err(e)) => tr!("经代理 {proxy} 连 {host}:{port} 失败：{e}", "Connecting to {host}:{port} through proxy {proxy} failed: {e}"),
                Err(_) => return Err(tr!("经代理 {proxy} 连 {host}:{port} 超时", "Connecting to {host}:{port} through proxy {proxy} timed out")),
            };
            if strict {
                return Err(first);
            }
            // 代理明确拒绝（公司代理常只放行 443 端口）：直连再试一次，两个原因都报出来
            crate::applog::info(&format!("{first}，改直连"));
            return match dial_direct(host, port).await {
                Ok(s) => Ok((s, false)),
                Err(e) => Err(tr!("{first}；改直连也失败：{e}", "{first}; a direct connection also failed: {e}")),
            };
        }
        if strict {
            return Err(tr!(
                "连不上自定义代理 {proxy}，请确认代理软件开着、地址没填错（设置 → 通用 → 代理）",
                "Can't reach the custom proxy {proxy}. Check that your proxy app is running and the address is right (Settings → General → Proxy)"
            ));
        }
        // 代理没开：直连
    }
    dial_direct(host, port).await.map(|s| (s, false))
}

/// 不走代理直连（代理节点封了某些端口时用，比如不少节点封 SMTP 的 587）
pub async fn dial_direct(host: &str, port: u16) -> Result<TcpStream, String> {
    tokio::time::timeout(Duration::from_secs(15), TcpStream::connect((host, port)))
        .await
        .map_err(|_| tr!("连接 {host}:{port} 超时", "Connecting to {host}:{port} timed out"))?
        .map_err(|e| tr!("连不上 {host}:{port}：{e}", "Can't connect to {host}:{port}: {e}"))
}

async fn tunnel(mut s: TcpStream, host: &str, port: u16) -> Result<TcpStream, String> {
    s.write_all(format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n").as_bytes()).await.map_err(|e| e.to_string())?;
    // 逐字节读到响应头结束：邮件服务器的欢迎语可能紧跟在后面，不能多读
    let mut head = Vec::with_capacity(256);
    let mut b = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 8192 || s.read(&mut b).await.map_err(|e| e.to_string())? == 0 {
            return Err(crate::i18n::t("代理断开了连接", "The proxy closed the connection").into());
        }
        head.push(b[0]);
    }
    let line = String::from_utf8_lossy(&head).lines().next().unwrap_or("").to_string();
    if line.split_whitespace().nth(1) == Some("200") {
        Ok(s)
    } else {
        Err(tr!("代理拒绝：{line}", "The proxy refused: {line}"))
    }
}

/// 「192.168.0.0/16」「169.254/16」这类网段写法（macOS 默认例外里就有）；不是网段写法返回 None
fn in_cidr(host: &str, pat: &str) -> Option<bool> {
    let (net, bits) = pat.split_once('/')?;
    let bits: u32 = bits.parse().ok().filter(|b| *b <= 32)?;
    let mut parts: Vec<u8> = net.split('.').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    if parts.is_empty() || parts.len() > 4 {
        return Some(false);
    }
    parts.resize(4, 0);
    let net = u32::from_be_bytes([parts[0], parts[1], parts[2], parts[3]]);
    let Ok(ip) = host.parse::<std::net::Ipv4Addr>() else { return Some(false) };
    let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
    Some(u32::from(ip) & mask == net & mask)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_server_formats() {
        assert_eq!(parse_server("127.0.0.1:7890").as_deref(), Some("127.0.0.1:7890"));
        assert_eq!(parse_server("http=127.0.0.1:1080;https=127.0.0.1:1081;socks=127.0.0.1:1082").as_deref(), Some("127.0.0.1:1081"));
        assert_eq!(parse_server("http://proxy.lan:8080/").as_deref(), Some("proxy.lan:8080"));
        assert_eq!(parse_server("socks=127.0.0.1:1080"), None);
    }

    #[test]
    fn scutil_output() {
        let t = "<dictionary> {\n  ExceptionsList : <array> {\n    0 : 127.0.0.1\n    1 : *.local\n  }\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 7891\n  HTTPSProxy : 127.0.0.1\n}";
        let (s, b) = parse_scutil(t).unwrap();
        assert_eq!(s, "127.0.0.1:7891");
        assert_eq!(b, vec!["127.0.0.1", "*.local"]);
        assert!(parse_scutil("<dictionary> {\n  HTTPEnable : 0\n}").is_none());
    }

    #[test]
    fn bypass_list() {
        let l: Vec<String> = ["localhost", "127.*", "*.corp.cn", "<local>"].iter().map(|s| s.to_string()).collect();
        assert!(bypassed("127.0.0.1", &l));
        assert!(bypassed("mail.corp.cn", &l));
        assert!(bypassed("intranet", &l));
        assert!(!bypassed("imap.gmail.com", &l));
        let m: Vec<String> = ["192.168.0.0/16", "169.254/16"].iter().map(|s| s.to_string()).collect();
        assert!(bypassed("192.168.1.10", &m));
        assert!(bypassed("169.254.3.4", &m));
        assert!(!bypassed("10.0.0.1", &m));
        assert!(!bypassed("mail.example.com", &m));
    }

    #[test]
    fn proxy_modes() {
        let sys = || Some(("1.2.3.4:7890".to_string(), vec!["*.corp.cn".to_string()]));
        assert_eq!(pick(&Mode::System, sys, "imap.gmail.com"), Some(("1.2.3.4:7890".to_string(), false)));
        assert_eq!(pick(&Mode::System, sys, "mail.corp.cn"), None);
        assert_eq!(pick(&Mode::Off, || panic!("不该读系统代理"), "imap.gmail.com"), None);
        let c = Mode::Custom("127.0.0.1:7890".into());
        assert_eq!(pick(&c, || panic!("不该读系统代理"), "imap.gmail.com"), Some(("127.0.0.1:7890".to_string(), true)));
        assert_eq!(pick(&c, || panic!("不该读系统代理"), "127.0.0.1"), None);
        assert_eq!(pick(&c, || panic!("不该读系统代理"), "localhost"), None);
    }

    #[test]
    fn clean_addr_formats() {
        assert_eq!(clean_addr("127.0.0.1:7890").as_deref(), Some("127.0.0.1:7890"));
        assert_eq!(clean_addr(" http://proxy.lan:8080/ ").as_deref(), Some("proxy.lan:8080"));
        for bad in ["socks5://127.0.0.1:1080", "127.0.0.1", ":7890", "a:0", "a:99999"] {
            assert_eq!(clean_addr(bad), None, "{bad}");
        }
    }

    /// 自定义代理没开：直接报错、报错里带代理地址，不退回直连
    #[tokio::test]
    async fn custom_proxy_down_is_error() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap().to_string();
        drop(l);
        let r = dial_by(Some((addr.clone(), true)), "imap.example.com", 993).await;
        let e = r.err().expect("应该报错");
        assert!(e.contains(&addr), "{e}");
    }

    /// 假代理：回 200 后紧跟一行「欢迎语」，确认欢迎语没被握手吃掉
    #[tokio::test]
    async fn tunnel_keeps_greeting() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = [0u8; 512];
            let n = s.read(&mut buf).await.unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).starts_with("CONNECT imap.example.com:993 HTTP/1.1"));
            s.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n* OK hello\r\n").await.unwrap();
        });
        let s = TcpStream::connect(addr).await.unwrap();
        let mut s = tunnel(s, "imap.example.com", 993).await.unwrap();
        let mut g = [0u8; 12];
        s.read_exact(&mut g).await.unwrap();
        assert_eq!(&g, b"* OK hello\r\n");
    }
}

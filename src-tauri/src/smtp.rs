//! 发信：mail-builder 组信，lettre 走 SMTP（465 直连 TLS / 587 STARTTLS）。
//! 连接自己建（跟随系统代理，见 net.rs），再交给 lettre 跑 SMTP 协议。

use crate::mime::Addr;
use anyhow::{anyhow, Result};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::client::{AsyncSmtpConnection, AsyncTokioStream, TlsParameters};
use lettre::transport::smtp::extension::ClientId;
use mail_builder::headers::address::Address as MbAddress;
use mail_builder::mime::MimePart;
use mail_builder::MessageBuilder;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;

pub struct SmtpCfg {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub username: String,
    /// 密码/授权码；一键登录的账号是短期令牌
    pub password: String,
    pub oauth: bool,
}

pub struct OutAttachment {
    pub name: String,
    pub mime: String,
    pub data: Vec<u8>,
}

pub struct Outgoing {
    pub from: Addr,
    pub to: Vec<Addr>,
    pub cc: Vec<Addr>,
    pub bcc: Vec<Addr>,
    pub subject: String,
    pub text: String,
    pub html: String,
    pub in_reply_to: String,
    pub references: String,
    pub attachments: Vec<OutAttachment>,
}

/// 465 端口：TLS 由我们先握手，再交给 lettre
struct TlsConn(tokio_native_tls::TlsStream<TcpStream>, std::net::SocketAddr);

impl std::fmt::Debug for TlsConn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "TlsConn({})", self.1)
    }
}

impl AsyncRead for TlsConn {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl AsyncWrite for TlsConn {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

impl AsyncTokioStream for TlsConn {
    fn peer_addr(&self) -> std::io::Result<std::net::SocketAddr> {
        Ok(self.1)
    }
}

fn no_response() -> &'static str {
    crate::i18n::t(NO_RESP_ZH, NO_RESP_EN)
}
const NO_RESP_ZH: &str = "发信服务器没有响应：";
const NO_RESP_EN: &str = "The outgoing server didn't respond: ";

/// 连上、加密、登录
async fn open(c: &SmtpCfg) -> Result<AsyncSmtpConnection> {
    let (tcp, via_proxy) = crate::net::dial(&c.host, c.port).await.map_err(|e| anyhow!(tr!("连不上发信服务器：{e}", "Can't reach the outgoing mail server: {e}")))?;
    let mut conn = if via_proxy {
        // 不少代理节点封 SMTP 端口（iCloud 的 587 就是）：隧道建好了却收不到欢迎语，或者一直没动静。
        // 只有这两种情况改直连再试；证书错、不支持 STARTTLS 之类直连也一样，照原样报
        let first = match tokio::time::timeout(Duration::from_secs(15), handshake(c, tcp)).await {
            Ok(Ok(conn)) => Ok(conn),
            Ok(Err(x)) if !crate::i18n::starts_with_any(&x.to_string(), NO_RESP_ZH, NO_RESP_EN) => return Err(x),
            Ok(Err(x)) => Err(x.to_string()),
            Err(_) => Err(crate::i18n::t("15 秒没有响应", "no response in 15 seconds").to_string()),
        };
        match first {
            Ok(conn) => conn,
            Err(first) => {
                let fail = |x: String| anyhow!(tr!("经代理连发信服务器失败（{first}），改直连也失败：{x}", "Connecting to the outgoing server through the proxy failed ({first}), and a direct connection also failed: {x}"));
                let tcp = crate::net::dial_direct(&c.host, c.port).await.map_err(fail)?;
                timed(20, handshake(c, tcp)).await.map_err(|x| fail(x.to_string()))?
            }
        }
    } else {
        handshake(c, tcp).await?
    };
    login(c, &mut conn).await?;
    Ok(conn)
}

/// 收欢迎语、加密（465 直连 TLS；其他端口必须 STARTTLS，不发明文）
async fn handshake(c: &SmtpCfg, tcp: TcpStream) -> Result<AsyncSmtpConnection> {
    let peer = tcp.peer_addr()?;
    let hello = ClientId::default();
    let conn = if c.tls && c.port == 465 {
        let cx = native_tls::TlsConnector::new().map_err(|e| anyhow!(tr!("TLS 初始化失败：{e}", "TLS setup failed: {e}")))?;
        let tls = tokio_native_tls::TlsConnector::from(cx).connect(&c.host, tcp).await.map_err(|e| anyhow!(tr!("发信服务器 TLS 握手失败：{e}", "TLS handshake with the outgoing server failed: {e}")))?;
        AsyncSmtpConnection::connect_with_transport(Box::new(TlsConn(tls, peer)), &hello).await.map_err(|e| anyhow!("{}{e}", no_response()))?
    } else {
        let mut conn = AsyncSmtpConnection::connect_with_transport(Box::new(tcp), &hello).await.map_err(|e| anyhow!("{}{e}", no_response()))?;
        if !conn.can_starttls() {
            return Err(anyhow!("{}", crate::i18n::t("发信服务器不支持加密连接（STARTTLS），为了安全不发送", "The outgoing server doesn't support an encrypted connection (STARTTLS), so nothing was sent")));
        }
        let params = TlsParameters::new(c.host.clone()).map_err(|e| anyhow!(tr!("TLS 初始化失败：{e}", "TLS setup failed: {e}")))?;
        conn.starttls(params, &hello).await.map_err(|e| anyhow!(tr!("发信服务器 TLS 握手失败：{e}", "TLS handshake with the outgoing server failed: {e}")))?;
        conn
    };
    Ok(conn)
}

async fn login(c: &SmtpCfg, conn: &mut AsyncSmtpConnection) -> Result<()> {
    if c.oauth {
        // XOAUTH2 自己发：令牌被拒时服务器先回 334 + 错误说明，要回一个空行才拿到真正的失败原因（lettre 遇到 334 只会报看不懂的错）
        use base64::Engine;
        let ir = base64::engine::general_purpose::STANDARD.encode(format!("user={}\x01auth=Bearer {}\x01\x01", c.username, c.password));
        let r = conn.command(format!("AUTH XOAUTH2 {ir}\r\n")).await.map_err(|e| anyhow!("{}{e}", auth_fail()))?;
        if !r.has_code(235) {
            let e = match conn.command("\r\n").await {
                Err(e) => e.to_string(),
                Ok(r) => r.message().collect::<Vec<_>>().join(" "),
            };
            return Err(anyhow!("{}{e}", auth_fail()));
        }
    } else {
        conn.auth(&[Mechanism::Plain, Mechanism::Login], &Credentials::new(c.username.clone(), c.password.clone())).await.map_err(|e| anyhow!("{}{e}", auth_fail()))?;
    }
    Ok(())
}

/// 登录失败的错误都以这个开头（发信时据此判断要不要换个令牌重试）
/// 报错前缀：上层靠它认出「登录失败」
pub fn auth_fail() -> &'static str {
    crate::i18n::t(AUTH_FAIL_ZH, AUTH_FAIL_EN)
}
const AUTH_FAIL_ZH: &str = "发信服务器登录失败：";
const AUTH_FAIL_EN: &str = "Sign-in to the outgoing server failed: ";
pub fn is_auth_fail(e: &str) -> bool {
    crate::i18n::starts_with_any(e, AUTH_FAIL_ZH, AUTH_FAIL_EN)
}

/// 收尾：服务器不回 QUIT 也别卡住（信已经发出去了）
async fn quit(mut conn: AsyncSmtpConnection) {
    let _ = tokio::time::timeout(Duration::from_secs(5), conn.quit()).await;
}

async fn timed<T>(secs: u64, f: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(Duration::from_secs(secs), f).await.map_err(|_| anyhow!("{}", crate::i18n::t("发信服务器响应超时", "The outgoing server timed out")))?
}

/// 连上到登录完的总时限：代理那条路最多约 40 秒，还要留出改直连的时间
const OPEN_SECS: u64 = 90;

/// 附件大时上传慢，按大小给时间（至少 1 分钟，每 MB 再加 20 秒）
pub fn upload_secs(len: usize) -> u64 {
    60 + (len as u64 / 1_000_000) * 20
}

pub async fn test(c: &SmtpCfg) -> Result<()> {
    let conn = timed(OPEN_SECS, open(c)).await?;
    quit(conn).await;
    Ok(())
}

/// 组好原始邮件。SMTP 发信不带 Bcc 头（密送人只走信封）；Graph 发信没有信封，靠 Bcc 头给密送人，Graph 发出时会去掉
pub fn build(o: &Outgoing, domain: &str, bcc_header: bool) -> Result<Vec<u8>> {
    let list = |v: &Vec<Addr>| MbAddress::new_list(v.iter().map(|a| MbAddress::new_address(if a.name.is_empty() { None } else { Some(a.name.clone()) }, a.email.clone())).collect());
    let msgid = format!("{}.{}@{}", chrono::Utc::now().timestamp_millis(), std::process::id(), domain);
    let mut b = MessageBuilder::new()
        .from(MbAddress::new_address(if o.from.name.is_empty() { None } else { Some(o.from.name.clone()) }, o.from.email.clone()))
        .to(list(&o.to))
        .subject(o.subject.clone())
        .message_id(msgid)
        .text_body(o.text.clone())
        .header("X-Mailer", mail_builder::headers::raw::Raw::new("Kojoo Mail"));
    if !o.cc.is_empty() {
        b = b.cc(list(&o.cc));
    }
    if bcc_header && !o.bcc.is_empty() {
        b = b.bcc(list(&o.bcc));
    }
    // 正文里写成一长串字符的图片（签名里的 logo）改成邮件的内嵌图片再发：Gmail、Outlook 不显示前一种
    let (html, images) = embed_data_images(&o.html, domain);
    let custom = if !images.is_empty() {
        // 有内嵌图片时自己排结构：纯文字 / （排版正文 + 图片）二选一，外面再挂附件。
        // 交给 mail-builder 默认排的话，图片和附件平级，不少邮箱会把它们又当成附件列一遍
        let mut related = vec![MimePart::new("text/html", html)];
        for (mime, cid, data) in images {
            related.push(MimePart::new(mime, data).inline().cid(cid));
        }
        let alt = MimePart::new("multipart/alternative", vec![MimePart::new("text/plain", o.text.clone()), MimePart::new("multipart/related", related)]);
        let body = if o.attachments.is_empty() {
            alt
        } else {
            let mut parts = vec![alt];
            for a in &o.attachments {
                parts.push(MimePart::new(a.mime.clone(), a.data.clone()).attachment(a.name.clone()));
            }
            MimePart::new("multipart/mixed", parts)
        };
        Some(body)
    } else {
        None
    };
    if custom.is_none() && !o.html.is_empty() {
        b = b.html_body(o.html.clone());
    }
    if !o.in_reply_to.is_empty() {
        b = b.in_reply_to(o.in_reply_to.trim_matches(|c| c == '<' || c == '>').to_string());
    }
    let refs: Vec<String> = o.references.split_whitespace().map(|s| s.trim_matches(|c| c == '<' || c == '>').to_string()).filter(|s| !s.is_empty()).collect();
    if !refs.is_empty() {
        b = b.references(refs);
    }
    // 自己排了结构的（有内嵌图片）整个正文换成它，附件已经在里面；别在上面提前返回：回复要带的 In-Reply-To / References 在这之前才加上
    match custom {
        Some(body) => b = b.body(body),
        None => {
            for a in &o.attachments {
                b = b.attachment(a.mime.clone(), a.name.clone(), a.data.clone());
            }
        }
    }
    Ok(b.write_to_vec()?)
}

/// 把 `<img src="data:image/…;base64,…">` 换成 `cid:`，返回新的正文和要内嵌的图片（类型、编号、内容）。
/// 只认 img 标签里的、只认 png / jpeg / gif / webp；解不开的原样留着。同一张图只带一份
pub(crate) fn embed_data_images(html: &str, domain: &str) -> (String, Vec<(String, String, Vec<u8>)>) {
    use base64::Engine;
    const MARK: &str = "src=\"data:image/";
    let mut out = String::with_capacity(html.len());
    let mut images: Vec<(String, String, Vec<u8>)> = vec![];
    let mut seen: Vec<(String, String)> = vec![]; // 原来的那串字符 → 编号
    let stamp = chrono::Utc::now().timestamp_millis();
    let mut rest = html;
    while let Some(i) = rest.to_ascii_lowercase().find("<img") {
        let (before, tag_on) = rest.split_at(i);
        out.push_str(before);
        // 标签到哪儿结束：引号里的 > 不算
        let mut end = tag_on.len();
        let mut quote = None;
        for (k, ch) in tag_on.char_indices() {
            match (quote, ch) {
                (None, '"') | (None, '\'') => quote = Some(ch),
                (Some(q), c) if c == q => quote = None,
                (None, '>') => {
                    end = k + 1;
                    break;
                }
                _ => {}
            }
        }
        let (tag, after) = tag_on.split_at(end);
        rest = after;
        // 界面清洗时不分大小写（DATA:IMAGE/PNG;BASE64, 也放行），这里也得认，不然发出去的还是对方看不到的那种。
        // 转成小写只动英文字母，长度和位置都不变，找到位置后回原文里取
        let lower = tag.to_ascii_lowercase();
        let parsed = lower.find(MARK).and_then(|a| {
            let val_start = a + 5; // 跳过 src="
            let val_len = tag[val_start..].find('"')?;
            let val = &tag[val_start..val_start + val_len];
            let cut = lower[val_start..val_start + val_len].find(";base64,")?;
            let (head, b64) = (&lower[val_start..val_start + cut], &val[cut + ";base64,".len()..]);
            let mime = match &head["data:".len()..] {
                "image/png" => "image/png",
                "image/jpeg" | "image/jpg" => "image/jpeg",
                "image/gif" => "image/gif",
                "image/webp" => "image/webp",
                _ => return None,
            };
            Some((val_start, val_len, mime, b64))
        });
        let Some((val_start, val_len, mime, b64)) = parsed else {
            out.push_str(tag);
            continue;
        };
        let key = format!("{mime};{b64}");
        let cid = match seen.iter().find(|(v, _)| *v == key) {
            Some((_, cid)) => cid.clone(),
            None => {
                let clean: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
                let data = base64::engine::general_purpose::STANDARD
                    .decode(clean.as_bytes())
                    .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(clean.trim_end_matches('=').as_bytes()));
                let Ok(data) = data else {
                    out.push_str(tag);
                    continue;
                };
                let cid = format!("img{}.{}@{}", images.len() + 1, stamp, domain);
                images.push((mime.to_string(), cid.clone(), data));
                seen.push((key, cid.clone()));
                cid
            }
        };
        out.push_str(&tag[..val_start]);
        out.push_str("cid:");
        out.push_str(&cid);
        out.push_str(&tag[val_start + val_len..]);
    }
    out.push_str(rest);
    (out, images)
}

/// 信封：发件人和全部收件人（含密送），顺带检查地址格式。Graph 发信不用信封，但也先过这一遍
pub fn envelope(o: &Outgoing) -> Result<lettre::address::Envelope> {
    let from: lettre::Address = o.from.email.parse().map_err(|_| anyhow!(tr!("发件地址不对：{}", "Invalid sender address: {}", o.from.email)))?;
    let mut rcpt = vec![];
    for a in o.to.iter().chain(&o.cc).chain(&o.bcc) {
        rcpt.push(a.email.parse::<lettre::Address>().map_err(|_| anyhow!(tr!("收件地址不对：{}", "Invalid recipient address: {}", a.email)))?);
    }
    if rcpt.is_empty() {
        return Err(anyhow!("{}", crate::i18n::t("没有收件人", "No recipients")));
    }
    lettre::address::Envelope::new(Some(from), rcpt).map_err(|e| anyhow!("{e}"))
}

pub async fn send(c: &SmtpCfg, o: &Outgoing, raw: &[u8]) -> Result<()> {
    let env = envelope(o)?;
    let mut conn = timed(OPEN_SECS, open(c)).await?;
    timed(upload_secs(raw.len()), async { conn.send(&env, raw).await.map_err(|e| anyhow!(tr!("发送失败：{e}", "Sending failed: {e}"))) }).await?;
    quit(conn).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内嵌图片：换成 cid、同一张只带一份、不认识的和解不开的原样留着；组出来的信自己能读回来
    #[test]
    fn data_images_become_inline_parts() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        let html = format!(
            "<p>你好 &lt;img src=x&gt;</p><img alt=\"a>b\" src=\"data:image/png;base64,{png}\" width=\"80\"><img src=\"https://e.com/x.png\"><img src=\"data:image/png;base64,{png}\"><img src=\"data:image/svg+xml;base64,AAAA\"><img src=\"data:image/png;base64,***\"><IMG SRC=\"DATA:IMAGE/PNG;BASE64,{png}\">"
        );
        let (out, images) = embed_data_images(&html, "kojoo.co");
        assert_eq!(images.len(), 1, "{out}");
        let cid = &images[0].1;
        // 三处都换了：两处一样的，加一处标签和前缀都大写的（同一张图，还是只带一份）
        assert_eq!(out.matches(&format!("=\"cid:{cid}\"")).count(), 3, "{out}");
        assert!(!out.contains("DATA:IMAGE"), "大写的没认出来：{out}");
        assert!(out.contains("alt=\"a>b\"") && out.contains("width=\"80\"") && out.contains("https://e.com/x.png"), "{out}");
        assert!(out.contains("data:image/svg+xml") && out.contains("base64,***"), "{out}");
        assert_eq!(images[0].0, "image/png");
        assert_eq!(&images[0].2[..4], b"\x89PNG");
        // 没有图片的不动
        assert_eq!(embed_data_images("<p>a</p>", "x").0, "<p>a</p>");

        let a = |e: &str| Addr { name: String::new(), email: e.into() };
        let mut o = Outgoing {
            from: a("me@kojoo.co"),
            to: vec![a("to@example.com")],
            cc: vec![],
            bcc: vec![],
            subject: "s".into(),
            text: "纯文字".into(),
            html,
            in_reply_to: "<orig@example.com>".into(),
            references: "<first@example.com> <orig@example.com>".into(),
            attachments: vec![],
        };
        let raw = build(&o, "kojoo.co", false).unwrap();
        // 回复带的会话头还在（对方靠它把这封归到原来那串邮件里）
        let head = String::from_utf8_lossy(&raw).to_string();
        assert!(head.contains("In-Reply-To: <orig@example.com>") && head.contains("References: <first@example.com>"), "{head}");
        let full = crate::mime::parse_full(&raw);
        assert!(full.html.contains("cid:img1."), "{}", full.html);
        assert_eq!(full.text.trim(), "纯文字");
        assert_eq!(full.atts.iter().filter(|x| x.inline).count(), 1);
        assert_eq!(full.atts.iter().filter(|x| !x.inline).count(), 0);
        let s = String::from_utf8_lossy(&raw).to_string();
        assert!(s.contains("multipart/related") && s.contains("multipart/alternative") && !s.contains("multipart/mixed"), "{s}");
        // 再带一个附件：附件在最外层，图片还是跟着正文
        o.attachments.push(OutAttachment { name: "a.txt".into(), mime: "text/plain".into(), data: b"hi".to_vec() });
        let raw = build(&o, "kojoo.co", false).unwrap();
        let full = crate::mime::parse_full(&raw);
        assert_eq!(full.atts.iter().filter(|x| x.inline).count(), 1);
        assert_eq!(full.atts.iter().filter(|x| !x.inline).map(|x| x.name.clone()).collect::<Vec<_>>(), vec!["a.txt".to_string()]);
        assert!(String::from_utf8_lossy(&raw).contains("multipart/mixed"));
    }

    /// SMTP 版不带 Bcc 头（密送人只走信封）；Graph 版要带，Graph 靠它投递给密送人
    #[test]
    fn bcc_header_only_for_graph() {
        let a = |e: &str| Addr { name: String::new(), email: e.into() };
        let o = Outgoing {
            from: a("me@outlook.com"),
            to: vec![a("to@example.com")],
            cc: vec![],
            bcc: vec![a("hidden@example.com")],
            subject: "s".into(),
            text: "t".into(),
            html: String::new(),
            in_reply_to: String::new(),
            references: String::new(),
            attachments: vec![],
        };
        let smtp = String::from_utf8(build(&o, "outlook.com", false).unwrap()).unwrap();
        let graph = String::from_utf8(build(&o, "outlook.com", true).unwrap()).unwrap();
        assert!(!smtp.contains("hidden@example.com"));
        assert!(graph.contains("Bcc: <hidden@example.com>") || graph.contains("Bcc: hidden@example.com"), "{graph}");
    }
}

//! 邮件解析：头部（列表用）和全文（读信用）

use crate::text;
use mail_parser::{Address, HeaderValue, MessageParser, MimeHeaders};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Addr {
    pub name: String,
    pub email: String,
}

#[derive(Default, Debug)]
pub struct Head {
    pub subject: String,
    pub from: Addr,
    pub to: Vec<Addr>,
    pub cc: Vec<Addr>,
    pub reply_to: String,
    pub date: i64,
    pub msgid: String,
    pub in_reply_to: String,
    pub refs: String,
    pub bulk: bool,
    /// 邮件列表 / 营销简报（有退订、List-Id）；bulk 里剩下的是系统通知（noreply 之类）
    pub subscription: bool,
    pub multipart_mixed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AttInfo {
    pub idx: usize,
    pub name: String,
    pub size: usize,
    pub mime: String,
    pub inline: bool,
}

pub struct Full {
    pub text: String,
    pub html: String,
    pub atts: Vec<AttInfo>,
}

fn addrs(a: Option<&Address>) -> Vec<Addr> {
    let Some(a) = a else { return vec![] };
    a.iter()
        .filter_map(|x| {
            let email = x.address().unwrap_or("").trim().to_string();
            if email.is_empty() {
                return None;
            }
            Some(Addr { name: x.name().unwrap_or("").trim().trim_matches('"').to_string(), email })
        })
        .collect()
}

fn hv_text(v: &HeaderValue) -> String {
    match v {
        HeaderValue::Text(t) => t.to_string(),
        HeaderValue::TextList(l) => l.iter().map(|s| format!("<{}>", s)).collect::<Vec<_>>().join(" "),
        _ => String::new(),
    }
}

pub fn parse_head(raw: &[u8]) -> Head {
    let Some(m) = MessageParser::default().parse(raw) else { return Head::default() };
    let from = addrs(m.from()).into_iter().next().unwrap_or_default();
    let low_from = from.email.to_lowercase();
    // 系统通知（GitHub、工单、告警）也常带退订头，按发件人归回「通知」
    let notifier = ["notification", "alert", "mailer-daemon", "postmaster"].iter().any(|k| low_from.contains(k));
    let subscription = !notifier
        && (!m.list_unsubscribe().is_empty()
            || !m.list_id().is_empty()
            || m.header_raw("Precedence").map(|p| { let p = p.to_lowercase(); p.contains("bulk") || p.contains("list") }).unwrap_or(false)
            || low_from.contains("newsletter"));
    let bulk = subscription
        || ["noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "notification", "newsletter", "mailer-daemon"]
            .iter()
            .any(|k| low_from.contains(k));
    let ct = m.header_raw("Content-Type").unwrap_or("").to_lowercase();
    Head {
        subject: m.subject().unwrap_or("").trim().to_string(),
        from,
        to: addrs(m.to()),
        cc: addrs(m.cc()),
        reply_to: addrs(m.reply_to()).into_iter().next().map(|a| a.email).unwrap_or_default(),
        date: m.date().map(|d| d.to_timestamp()).unwrap_or(0),
        msgid: m.message_id().map(|s| format!("<{s}>")).unwrap_or_default(),
        in_reply_to: hv_text(m.in_reply_to()),
        refs: hv_text(m.references()),
        bulk,
        subscription,
        multipart_mixed: ct.contains("multipart/mixed"),
    }
}

pub fn parse_full(raw: &[u8]) -> Full {
    let Some(m) = MessageParser::default().parse(raw) else {
        return Full { text: String::from_utf8_lossy(raw).into_owned(), html: String::new(), atts: vec![] };
    };
    let html = m.body_html(0).map(|c| c.into_owned()).unwrap_or_default();
    // 有些邮件只有 HTML：纯文本由 HTML 转出来
    let text = match m.body_text(0) {
        Some(t) if !t.trim().is_empty() && m.text_body_count() > 0 && !m.text_part(0).map(|p| p.is_text_html()).unwrap_or(false) => t.into_owned(),
        _ if !html.is_empty() => text::html_to_text(&html),
        Some(t) => t.into_owned(),
        None => String::new(),
    };
    let mut atts = vec![];
    for (idx, p) in m.attachments().enumerate() {
        let mime = p
            .content_type()
            .map(|c| format!("{}/{}", c.ctype(), c.subtype().unwrap_or("")))
            .unwrap_or_else(|| "application/octet-stream".into())
            .to_lowercase();
        let inline = p.content_id().is_some() && mime.starts_with("image/") && p.attachment_name().is_none();
        let name = att_name(&p, idx, &mime);
        atts.push(AttInfo { idx, name, size: p.contents().len(), mime, inline });
    }
    Full { text, html, atts }
}

/// 取第 idx 个附件的内容
pub fn attachment_bytes(raw: &[u8], idx: usize) -> Option<(String, Vec<u8>)> {
    let m = MessageParser::default().parse(raw)?;
    let p = m.attachment(idx as u32 as usize)?;
    let mime = p.content_type().map(|c| format!("{}/{}", c.ctype(), c.subtype().unwrap_or(""))).unwrap_or_else(|| "application/octet-stream".into()).to_lowercase();
    let name = att_name(p, idx, &mime);
    Some((name, p.contents().to_vec()))
}

/// 附件的名字：列表显示、保存、打开都用这一个，不会一处有后缀一处没有
fn att_name(p: &mail_parser::MessagePart, idx: usize, mime: &str) -> String {
    match p.attachment_name() {
        Some(s) => fix_att_name(s, if p.is_message() { "message/rfc822" } else { mime }),
        None if p.is_message() => tr!("邮件附件 {}.eml", "Attached email {}.eml", idx + 1),
        None => fix_att_name(&tr!("附件 {}", "Attachment {}", idx + 1), mime),
    }
}

/// 附件名收尾：
/// 1. 名字里还留着 =?utf-8?B?…?= 这种编码（有的发件方把编码过的名字拆成 filename*0 / filename*1 两段，
///    解析库拼起来就不再解码了，比如通行费电子发票）→ 再解一次。借解析库自己解标题的那套，各种字符集都认
/// 2. 没有后缀、但类型明确（PDF、压缩包这些）→ 按类型补上后缀，不然存下来打不开、点开也会被当成程序拦下
pub fn fix_att_name(name: &str, mime: &str) -> String {
    let mut n = strip_invisible(name.trim());
    if n.contains("=?") && n.contains("?=") {
        let fake = format!("Subject: {}\r\n\r\n", n.replace(['\r', '\n'], ""));
        if let Some(s) = MessageParser::default().parse(fake.as_bytes()).and_then(|m| m.subject().map(|s| s.to_string())) {
            if !s.trim().is_empty() && !s.contains("=?") {
                n = strip_invisible(s.trim());
            }
        }
    }
    // 点后面是英文字母开头的短串就算已有后缀（server.log、config.yaml、本来就是 .exe 的照旧认，打开时照旧被拦）；
    // 纯数字（「发票 35.50」「2026.11」）、带空格或别的字符的不算，按类型补
    let has_ext = std::path::Path::new(&n).extension().map(|e| e.to_string_lossy().to_string()).is_some_and(|e| {
        let mut cs = e.chars();
        e.len() <= 8 && cs.next().is_some_and(|c| c.is_ascii_alphabetic()) && cs.all(|c| c.is_ascii_alphanumeric())
    });
    if !has_ext {
        let ext = match mime {
            "message/rfc822" => "eml",
            "application/pdf" => "pdf",
            "application/zip" | "application/x-zip-compressed" => "zip",
            "application/ofd" => "ofd",
            "text/xml" | "application/xml" => "xml",
            "image/jpeg" => "jpg",
            "image/png" => "png",
            "application/msword" => "doc",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
            "application/vnd.ms-excel" => "xls",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
            "text/csv" => "csv",
            "text/plain" => "txt",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "application/vnd.ms-powerpoint" => "ppt",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
            "application/x-rar-compressed" | "application/vnd.rar" => "rar",
            "application/x-7z-compressed" => "7z",
            _ => "",
        };
        if !ext.is_empty() {
            n = format!("{n}.{ext}");
        }
    }
    n
}

/// 去掉文件名里看不见的格式字符：反向显示（U+202E 等能把名为 invoice<U+202E>fdp.exe 的程序显示成 .pdf 结尾）、零宽字符、BOM
fn strip_invisible(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(*c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}' | '\u{061C}' | '\u{180E}'))
        .collect()
}

/// 正文里 cid: 引用的内嵌图片 → data: URL（单张 ≤ 3MB，总共 ≤ 10MB）
pub fn inline_images(raw: &[u8]) -> Vec<(String, String)> {
    let Some(m) = MessageParser::default().parse(raw) else { return vec![] };
    let mut out = vec![];
    let mut total = 0usize;
    for p in m.attachments() {
        let Some(cid) = p.content_id() else { continue };
        let Some(ct) = p.content_type() else { continue };
        if !ct.ctype().eq_ignore_ascii_case("image") {
            continue;
        }
        let bytes = p.contents();
        if bytes.len() > 3_000_000 || total + bytes.len() > 10_000_000 {
            continue;
        }
        total += bytes.len();
        let mime = format!("image/{}", ct.subtype().unwrap_or("png"));
        out.push((cid.trim_matches(|c| c == '<' || c == '>').to_string(), format!("data:{};base64,{}", mime, b64(bytes))));
    }
    out
}

pub fn b64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len() * 4 / 3 + 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn head_and_body() {
        let raw = b"From: =?UTF-8?B?5byg5LiJ?= <zs@example.com>\r\nTo: a@b.c\r\nSubject: =?UTF-8?B?5L2g5aW9?=\r\nDate: Mon, 19 Oct 2026 09:42:00 +0800\r\nMessage-ID: <x1@ex>\r\nList-Unsubscribe: <mailto:u@ex>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><head><style>p{color:red}</style></head><body><p>Hello <b>World</b></p></body></html>";
        let h = parse_head(raw);
        assert_eq!(h.subject, "你好");
        assert_eq!(h.from.name, "张三");
        assert!(h.bulk && h.subscription);
        assert_eq!(h.msgid, "<x1@ex>");
        let n = parse_head(b"From: Bank <noreply@bank.example>\r\nSubject: x\r\n\r\nhi");
        assert!(n.bulk && !n.subscription, "noreply 没有退订头的是通知，不是订阅");
        let g = parse_head(b"From: GitHub <notifications@github.com>\r\nList-Unsubscribe: <mailto:x@github.com>\r\nSubject: x\r\n\r\nhi");
        assert!(g.bulk && !g.subscription, "带退订头的系统通知仍是通知");
        let f = parse_full(raw);
        assert!(f.text.contains("Hello") && !f.text.contains("color"));
    }
    #[test]
    fn split_encoded_att_name() {
        // 通行费电子发票的真实写法：编码过的名字被拆成两段
        let raw = b"From: a@b.c\r\nSubject: x\r\nContent-Type: multipart/mixed; boundary=\"B\"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nhi\r\n--B\r\nContent-Type: application/pdf; \r\n\tname*0=\"=?utf-8?B?6YCa6KGM6LS555S15a2Q56Wo5o2u5rGH5oC75Y2VKOelqOaNri\"; \r\n\tname*1=\"kucGRm?=\"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; \r\n\tfilename*0=\"=?utf-8?B?6YCa6KGM6LS555S15a2Q56Wo5o2u5rGH5oC75Y2VKOelqOaNri\"; \r\n\tfilename*1=\"kucGRm?=\"\r\n\r\nJVBERi0=\r\n--B--\r\n";
        let f = parse_full(raw);
        assert_eq!(f.atts.len(), 1);
        assert_eq!(f.atts[0].name, "通行费电子票据汇总单(票据).pdf");
        assert_eq!(attachment_bytes(raw, 0).unwrap().0, "通行费电子票据汇总单(票据).pdf");
        // 没后缀的按类型补；正常名字不动；解不开的原样留着
        assert_eq!(fix_att_name("发票", "application/pdf"), "发票.pdf");
        assert_eq!(fix_att_name("发票.pdf", "application/octet-stream"), "发票.pdf");
        assert_eq!(fix_att_name("报告", "application/octet-stream"), "报告");
        assert_eq!(fix_att_name("=?gbk?B?suLK1A==?=", "text/plain"), "测试.txt");
        // 点后面不是常见后缀的照样补；本来是可执行后缀的不补（打开时照旧被拦）
        assert_eq!(fix_att_name("通行费发票 35.50", "application/pdf"), "通行费发票 35.50.pdf");
        assert_eq!(fix_att_name("a@b.com", "application/pdf"), "a@b.com");
        assert_eq!(fix_att_name("Forwarded message", "message/rfc822"), "Forwarded message.eml");
        // 不常见但正常的后缀不多补
        assert_eq!(fix_att_name("server.log", "text/plain"), "server.log");
        assert_eq!(fix_att_name("config.yaml", "text/plain"), "config.yaml");
        assert_eq!(fix_att_name("a.xlsm", "application/vnd.ms-excel"), "a.xlsm");
        assert_eq!(fix_att_name("发票 2026.11", "application/pdf"), "发票 2026.11.pdf");
        // 反向显示字符被去掉：显示出来就是真实的 .exe
        assert_eq!(fix_att_name("invoice\u{202E}fdp.exe", "application/octet-stream"), "invoicefdp.exe");
        assert_eq!(fix_att_name("=?utf-8?B?aW52b2ljZeKArmZkcC5leGU=?=", "application/pdf"), "invoicefdp.exe");
    }
    #[test]
    fn base64() {
        assert_eq!(b64(b"hello"), "aGVsbG8=");
    }
}

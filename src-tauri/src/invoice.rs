//! 发票台账（2026-11）：从邮件附件里认出发票，一张发票一行。
//!
//! - 按文件内容认，不看标题、不靠 AI 分类（实测 12 封发票邮件 AI 只分对 1 封）
//! - 压缩包拆开看（通行费发票一个压缩包十几张）；同名的 PDF / XML / OFD 是同一张发票的三种文件
//! - 读发票信息的顺序：数电票 XML（最准）→ OFD 里带的数据 → PDF 里的文字（读不全的标「待核对」，可以手工改）
//! - 同一个发票号只算一张：重复收到的（转发、两个地址各发一次）并在一起，记下来自哪几封邮件
//! - 行程单、汇总单、结账单这类不是发票：记成这封邮件的「附带材料」，导出时一起带上，不计数
//!
//! 境外的英文账单（Invoice / Receipt）第一版不进台账。

use crate::store::now;
use crate::{mime, Ctx};
use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

/// 扫描规则的版本：规则改了就加一，已经扫过的邮件会重新扫一遍
const SCAN_VER: i64 = 1;
/// 压缩包保护：最多看这么多个文件、单个文件和总共解出来不超过这么大（防压缩包炸弹）
const ZIP_MAX_FILES: usize = 300;
const ZIP_MAX_ONE: u64 = 20 * 1024 * 1024;
const ZIP_MAX_ALL: u64 = 120 * 1024 * 1024;
/// 单个附件超过这么大的不看
const ATT_MAX: usize = 40 * 1024 * 1024;
/// 一次导出的文件总量上限（压缩包是在内存里拼的）
const EXPORT_MAX: usize = 400 * 1024 * 1024;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Parsed {
    pub number: String,
    /// YYYY-MM-DD
    pub date: String,
    /// 价税合计（分）
    pub amount: Option<i64>,
    pub tax: Option<i64>,
    pub seller: String,
    pub seller_tax: String,
    pub buyer: String,
    pub buyer_tax: String,
    pub kind: String,
    /// xml | ofd | pdf
    pub source: &'static str,
}

fn rank(source: &str) -> i32 {
    match source {
        "xml" => 3,
        "ofd" => 2,
        "pdf" => 1,
        _ => 0,
    }
}

/// "123.45" / "1,234.5" / "¥88" → 分
pub fn cents(s: &str) -> Option<i64> {
    let t: String = s.chars().filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-').collect();
    if t.is_empty() || t.matches('.').count() > 1 {
        return None;
    }
    let neg = t.starts_with('-');
    let t = t.trim_start_matches('-');
    let (a, b) = t.split_once('.').unwrap_or((t, ""));
    if a.is_empty() && b.is_empty() || a.len() > 12 || !a.chars().all(|c| c.is_ascii_digit()) || !b.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut frac: String = b.chars().take(2).collect();
    while frac.len() < 2 {
        frac.push('0');
    }
    let v = a.parse::<i64>().unwrap_or(0) * 100 + frac.parse::<i64>().unwrap_or(0);
    Some(if neg { -v } else { v })
}

/// 各种写法的日期 → YYYY-MM-DD（2026-11-03、20261103、2026年11月3日、2026-11-03 10:00:00）
pub fn norm_date(s: &str) -> String {
    let digits: Vec<String> = s.split(|c: char| !c.is_ascii_digit()).filter(|x| !x.is_empty()).map(|x| x.to_string()).collect();
    let (y, m, d) = match digits.as_slice() {
        [one, ..] if one.len() >= 8 => (one[0..4].to_string(), one[4..6].to_string(), one[6..8].to_string()),
        [y, m, d, ..] if y.len() == 4 => (y.clone(), m.clone(), d.clone()),
        _ => return String::new(),
    };
    let (yi, mi, di) = (y.parse::<i32>().unwrap_or(0), m.parse::<u32>().unwrap_or(0), d.parse::<u32>().unwrap_or(0));
    if !(2000..=2100).contains(&yi) || !(1..=12).contains(&mi) || !(1..=31).contains(&di) {
        return String::new();
    }
    format!("{yi:04}-{mi:02}-{di:02}")
}

fn clean(s: &str, max: usize) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").chars().filter(|c| !c.is_control()).take(max).collect()
}

/// 数电票的 XML（根节点 EInvoice）。不是这种格式返回 None
pub fn parse_xml(data: &[u8]) -> Option<Parsed> {
    let text = std::str::from_utf8(data).ok()?.trim_start_matches('\u{feff}');
    let doc = roxmltree::Document::parse(text).ok()?;
    if doc.root_element().tag_name().name() != "EInvoice" {
        return None;
    }
    let get = |names: &[&str]| -> String {
        for n in names {
            if let Some(v) = doc.descendants().find(|x| x.is_element() && x.tag_name().name() == *n).and_then(|x| x.text()) {
                let v = clean(v, 120);
                if !v.is_empty() {
                    return v;
                }
            }
        }
        String::new()
    };
    let number = get(&["EIid", "InvoiceNumber"]);
    if number.is_empty() {
        return None;
    }
    Some(Parsed {
        number,
        date: norm_date(&get(&["IssueTime", "RequestTime"])),
        amount: cents(&get(&["TotalTax-includedAmount"])),
        tax: cents(&get(&["TotalTaxAm"])),
        seller: get(&["SellerName"]),
        seller_tax: get(&["SellerIdNum"]),
        buyer: get(&["BuyerName"]),
        buyer_tax: get(&["BuyerIdNum"]),
        kind: {
            let k = doc.descendants().find(|x| x.tag_name().name() == "EInvoiceType").and_then(|x| x.descendants().find(|y| y.tag_name().name() == "LabelName")).and_then(|x| x.text()).map(|v| clean(v, 40)).unwrap_or_default();
            if k.is_empty() { get(&["GeneralOrSpecialVAT"]) } else { k }
        },
        source: "xml",
    })
}

fn zip_open(data: &[u8]) -> Option<zip::ZipArchive<std::io::Cursor<&[u8]>>> {
    if data.len() < 4 || &data[..2] != b"PK" {
        return None;
    }
    zip::ZipArchive::new(std::io::Cursor::new(data)).ok()
}

fn zip_read(z: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>, name: &str, max: u64) -> Option<Vec<u8>> {
    let f = z.by_name(name).ok()?;
    if f.size() > max {
        return None;
    }
    let mut out = Vec::with_capacity(f.size().min(max) as usize);
    f.take(max + 1).read_to_end(&mut out).ok()?;
    if out.len() as u64 > max {
        return None;
    }
    Some(out)
}

/// OFD 版式文件（其实是压缩包）：里面带一份数电票数据的，按 XML 读；否则读 OFD.xml 里登记的发票号、日期、金额、双方税号
pub fn parse_ofd(data: &[u8]) -> Option<Parsed> {
    let mut z = zip_open(data)?;
    let names: Vec<String> = z.file_names().map(|s| s.to_string()).collect();
    if !names.iter().any(|n| n.eq_ignore_ascii_case("OFD.xml")) {
        return None;
    }
    for n in names.iter().filter(|n| n.to_ascii_lowercase().ends_with(".xml") && n.contains("Tag")).take(8) {
        if let Some(p) = zip_read(&mut z, n, 2 * 1024 * 1024).and_then(|b| parse_xml(&b)) {
            return Some(Parsed { source: "ofd", ..p });
        }
    }
    let main = names.iter().find(|n| n.eq_ignore_ascii_case("OFD.xml"))?;
    let b = zip_read(&mut z, main, 2 * 1024 * 1024)?;
    let text = std::str::from_utf8(&b).ok()?;
    let doc = roxmltree::Document::parse(text.trim_start_matches('\u{feff}')).ok()?;
    let mut m: BTreeMap<String, String> = BTreeMap::new();
    for x in doc.descendants().filter(|x| x.is_element() && x.tag_name().name() == "CustomData") {
        if let (Some(k), Some(v)) = (x.attribute("Name"), x.text()) {
            m.insert(k.to_string(), clean(v, 120));
        }
    }
    let number = m.get("发票号码").cloned().unwrap_or_default();
    if number.is_empty() {
        return None;
    }
    let net = m.get("合计金额").and_then(|v| cents(v));
    let tax = m.get("合计税额").and_then(|v| cents(v));
    Some(Parsed {
        number,
        date: norm_date(m.get("开票日期").map(String::as_str).unwrap_or("")),
        amount: m.get("价税合计").and_then(|v| cents(v)).or(match (net, tax) {
            (Some(a), Some(b)) => Some(a + b),
            (Some(a), None) => Some(a),
            _ => None,
        }),
        tax,
        seller_tax: m.get("销售方纳税人识别号").cloned().unwrap_or_default(),
        buyer_tax: m.get("购买方纳税人识别号").cloned().unwrap_or_default(),
        source: "ofd",
        ..Default::default()
    })
}

const NOT_INVOICE: &[&str] = &["汇总单", "行程单", "报销单", "结账单", "水单", "对账单", "明细单"];
const ORG_END: &[&str] = &["公司", "厂", "店", "中心", "事务所", "研究所", "研究院", "医院", "银行", "合作社", "协会", "学校", "大学", "经营部", "工作室", "酒店", "集团"];

/// 这一行里的单位名：整行就是一个名字（XX有限公司），或者写在「名称：」后面。结尾带括号说明的（…有限公司（杭州分公司））也算
fn org_in_line(l: &str) -> Option<String> {
    let cand = match l.rfind("名称：").map(|i| i + "名称：".len()).or_else(|| l.rfind("名称:").map(|i| i + "名称:".len())) {
        Some(i) => l[i..].trim(),
        None if l.contains('：') || l.contains(':') => return None,
        None => l,
    };
    let core = match cand.rfind(['（', '(']) {
        Some(i) if cand.ends_with(['）', ')']) && i > 0 => cand[..i].trim_end(),
        _ => cand,
    };
    let n = cand.chars().count();
    ((4..=40).contains(&n) && ORG_END.iter().any(|e| core.ends_with(e)) && cand.chars().all(|c| !c.is_whitespace())).then(|| cand.to_string())
}

/// 文字里第一个「正好 n 位」的数字串（前后不能还连着数字）
fn digit_run(t: &str, n: usize) -> Option<String> {
    let mut run = String::new();
    for c in t.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_digit() {
            run.push(c);
        } else {
            if run.len() == n {
                return Some(run);
            }
            run.clear();
        }
    }
    None
}

/// PDF 里读出来的文字是不是一张发票；是的话尽量读出发票号、日期、金额、两个单位名。
/// 文字里标签和数值不挨着（实测「发票号码」后面不跟数字），所以不找「标签后面的值」，而是在整页里找形状：
/// 单独一行的 20 位（或 8 位）数字 = 发票号；「年 月 日」= 开票日期；带 ¥ 的最大金额 = 价税合计。
/// 两个单位名谁是购买方看不出来（先后顺序跟排版走），先按出现顺序放，入库时再用已知的购买方名单校正
pub fn parse_pdf_text(t: &str) -> Option<Parsed> {
    let head: String = t.chars().take(800).collect();
    if !head.contains("发票") || NOT_INVOICE.iter().any(|k| head.contains(k)) {
        return None;
    }
    let lines: Vec<&str> = t.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    // 发票号：数电票是 20 位；老式电子发票是「发票号码」后面跟着的 8 位
    let number = digit_run(t, 20)
        .or_else(|| {
            let i = t.find("发票号码")? + "发票号码".len();
            let after: String = t[i..].chars().take(24).collect();
            let run: String = after.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
            (8..=12).contains(&run.len()).then_some(run)
        })
        .unwrap_or_default();
    if number.is_empty() && !t.contains("发票号码") {
        return None;
    }
    if !t.contains("价税合计") && !t.contains("开票日期") {
        return None;
    }
    // 开票日期：第一个「YYYY 年 M 月 D 日」。年份只取「年」前面紧挨着的 4 位数字（前一行常常是发票号，别把它的尾巴算进来）
    let mut date = String::new();
    let chars: Vec<char> = t.chars().collect();
    for i in 4..chars.len() {
        if chars[i] != '年' || !chars[i - 4..i].iter().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let rest: String = chars[i + 1..(i + 14).min(chars.len())].iter().collect();
        let (Some(m), Some(d)) = (rest.find('月'), rest.find('日')) else { continue };
        if m < d {
            let y: String = chars[i - 4..i].iter().collect();
            let got = norm_date(&format!("{y}-{}-{}", rest[..m].trim(), rest[m + '月'.len_utf8()..d].trim()));
            if !got.is_empty() {
                date = got;
                break;
            }
        }
    }
    // 价税合计：带 ¥ 的金额里最大的
    let mut amount: Option<i64> = None;
    for (i, c) in chars.iter().enumerate() {
        if *c == '¥' || *c == '￥' {
            let num: String = chars[i + 1..].iter().skip_while(|c| c.is_whitespace()).take_while(|c| c.is_ascii_digit() || **c == '.' || **c == ',').collect();
            if let Some(v) = cents(&num) {
                if num.contains('.') && amount.map_or(true, |a| v > a) {
                    amount = Some(v);
                }
            }
        }
    }
    let mut orgs: Vec<String> = vec![];
    for l in &lines {
        if let Some(o) = org_in_line(l) {
            if !orgs.contains(&o) {
                orgs.push(o);
            }
        }
    }
    Some(Parsed { number, date, amount, buyer: orgs.first().cloned().unwrap_or_default(), seller: orgs.get(1).cloned().unwrap_or_default(), source: "pdf", ..Default::default() })
}

/// 读 PDF 里的文字。在子进程里读（`kojoomail --pdf-text <文件>`）：读 PDF 的组件遇到怪文件可能直接崩，
/// 正式版一崩整个程序就没了（panic = abort），放到子进程里崩的只是它自己。超过 20 秒算读不了
pub fn pdf_text(data: &[u8]) -> Option<String> {
    if data.len() < 5 || &data[..4] != b"%PDF" {
        return None;
    }
    let dir = std::env::temp_dir().join("KojooMail").join("pdf-text");
    std::fs::create_dir_all(&dir).ok()?;
    let f = dir.join(format!("{}-{}.pdf", std::process::id(), now_nanos()));
    std::fs::write(&f, data).ok()?;
    let out = run_pdf_child(&f);
    let _ = std::fs::remove_file(&f);
    out
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

fn run_pdf_child(f: &std::path::Path) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--pdf-text").arg(f).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = stdout.take(4 * 1024 * 1024).read_to_end(&mut s);
        s
    });
    let t0 = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if t0.elapsed().as_secs() >= 20 => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(40)),
            Err(_) => break None,
        }
    };
    let bytes = reader.join().ok()?;
    if !status.is_some_and(|s| s.success()) {
        return None;
    }
    let s = String::from_utf8_lossy(&bytes).into_owned();
    if s.trim().is_empty() { None } else { Some(s) }
}

/// 子进程入口：把 PDF 里的文字打到标准输出。读不了就退出码 1
pub fn pdf_text_main(path: &str) -> i32 {
    let Ok(b) = std::fs::read(path) else { return 1 };
    match pdf_extract::extract_text_from_mem(&b) {
        Ok(t) => {
            let _ = std::io::stdout().write_all(t.as_bytes());
            0
        }
        Err(_) => 1,
    }
}

// ───────────────────────── 扫一封邮件 ─────────────────────────

struct Entry {
    att_idx: usize,
    /// 在压缩包里的路径；不在压缩包里为空
    inner: String,
    name: String,
    ext: String,
    data: Vec<u8>,
}

fn ext_of(name: &str) -> String {
    std::path::Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}
fn stem_of(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    std::path::Path::new(base).file_stem().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// 这封邮件里可能和发票有关的文件：PDF / XML / OFD，压缩包拆开一层
fn entries_of(raw: &[u8]) -> Vec<Entry> {
    let full = mime::parse_full(raw);
    let mut out = vec![];
    let mut total: u64 = 0;
    for a in full.atts.iter().filter(|a| !a.inline && a.size <= ATT_MAX) {
        let ext = ext_of(&a.name);
        if !["pdf", "xml", "ofd", "zip"].contains(&ext.as_str()) {
            continue;
        }
        let Some((_, data)) = mime::attachment_bytes(raw, a.idx) else { continue };
        if ext == "zip" {
            let Some(mut z) = zip_open(&data) else { continue };
            let names: Vec<String> = z.file_names().map(|s| s.to_string()).collect();
            for n in names.iter().take(ZIP_MAX_FILES) {
                let e = ext_of(n);
                if n.ends_with('/') || n.contains("..") || !["pdf", "xml", "ofd"].contains(&e.as_str()) {
                    continue;
                }
                let Some(b) = zip_read(&mut z, n, ZIP_MAX_ONE) else { continue };
                total += b.len() as u64;
                if total > ZIP_MAX_ALL {
                    return out;
                }
                out.push(Entry { att_idx: a.idx, inner: n.clone(), name: n.rsplit(['/', '\\']).next().unwrap_or(n).to_string(), ext: e, data: b });
            }
        } else {
            out.push(Entry { att_idx: a.idx, inner: String::new(), name: a.name.clone(), ext, data });
        }
    }
    out
}

pub struct Found {
    pub parsed: Parsed,
    /// (att_idx, inner, name, ext, size)
    pub files: Vec<(usize, String, String, String, usize)>,
    /// 读不出发票号时用来去重
    pub hash: String,
}

/// 把一封邮件的原文拆成：发票（每张带它的几个文件）+ 附带材料。`pdf` 是「怎么读 PDF 文字」，测试里换成假的
pub fn scan_raw(raw: &[u8], pdf: &dyn Fn(&[u8]) -> Option<String>) -> (Vec<Found>, Vec<(usize, String, String, String, usize)>, bool) {
    let entries = entries_of(raw);
    // 同名的 PDF / XML / OFD 是同一张发票
    let mut groups: BTreeMap<String, Vec<&Entry>> = BTreeMap::new();
    let mut seen: BTreeMap<(String, String), usize> = BTreeMap::new();
    for e in &entries {
        // 按文件名（不看目录、不看后缀）配对：通行费压缩包里 PDF、XML、OFD 分放在三个子目录，名字相同。
        // 同名同后缀第 n 次出现归到第 n 组：三个附件都叫「发票.pdf」/「发票.xml」，或压缩包里 1/发票.pdf、2/发票.pdf，是不同的发票
        let base = stem_of(&e.name);
        let n = seen.entry((base.clone(), e.ext.clone())).or_default();
        groups.entry(format!("{base}#{n}")).or_default().push(e);
        *n += 1;
    }
    let (mut found, mut extras): (Vec<Found>, Vec<_>) = (vec![], vec![]);
    let mut unreadable = false;
    for (_, g) in groups {
        let by = |ext: &str| g.iter().find(|e| e.ext == ext);
        let mut parsed = by("xml").and_then(|e| parse_xml(&e.data));
        if parsed.is_none() {
            parsed = by("ofd").and_then(|e| parse_ofd(&e.data));
        }
        if parsed.is_none() {
            if let Some(e) = by("pdf") {
                parsed = match pdf(&e.data) {
                    Some(t) => parse_pdf_text(&t),
                    None => {
                        unreadable = true;
                        e.name.contains("发票").then(|| Parsed { source: "pdf", ..Default::default() })
                    }
                };
            }
        }
        let tuple = |e: &&Entry| (e.att_idx, e.inner.clone(), e.name.clone(), e.ext.clone(), e.data.len());
        match parsed {
            Some(p) => {
                use sha2::{Digest, Sha256};
                let first = by("pdf").or_else(|| by("ofd")).or_else(|| g.first()).unwrap();
                let hash = format!("{:x}", Sha256::digest(&first.data));
                found.push(Found { parsed: p, files: g.iter().map(tuple).collect(), hash });
            }
            // 不是发票的 PDF：可能是行程单、汇总单这类附带材料（这封邮件里有发票才算）
            None => extras.extend(g.iter().filter(|e| e.ext == "pdf").map(tuple)),
        }
    }
    if found.is_empty() {
        extras.clear();
    }
    (found, extras, unreadable)
}

fn needs_check(number: &str, date: &str, amount: Option<i64>, buyer: &str, seller: &str) -> bool {
    number.is_empty() || date.is_empty() || amount.is_none() || buyer.is_empty() || seller.is_empty()
}

/// 扫描结果入库。同一个发票号并到一张上；手工改过的不覆盖；更准的来源（XML > OFD > PDF）覆盖不准的
pub fn save_scan(conn: &Connection, msg_id: i64, account_id: i64, msg_date: i64, found: &[Found], extras: &[(usize, String, String, String, usize)]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM invoice_files WHERE msg_id=?", [msg_id])?;
    for f in found {
        let mut p = f.parsed.clone();
        // 只有 PDF 的：两个单位名谁是购买方看不出来。已经从 XML / 手工确认过的购买方名单里有哪个，哪个就是购买方
        if p.source == "pdf" && !p.seller.is_empty() {
            let known = |name: &str| -> rusqlite::Result<bool> { tx.query_row("SELECT EXISTS(SELECT 1 FROM invoices WHERE buyer=?1 AND (source='xml' OR edited=1))", [name], |r| r.get(0)) };
            if known(&p.seller)? && !known(&p.buyer)? {
                std::mem::swap(&mut p.buyer, &mut p.seller);
            }
        }
        // 只有税号没有名字的（OFD）：借别的发票上同一个税号的名字
        for (tax, name, col, tcol) in [(p.buyer_tax.clone(), &mut p.buyer, "buyer", "buyer_tax"), (p.seller_tax.clone(), &mut p.seller, "seller", "seller_tax")] {
            if name.is_empty() && !tax.is_empty() {
                let sql = format!("SELECT {col} FROM invoices WHERE {tcol}=?1 AND {col}<>'' UNION SELECT buyer FROM invoices WHERE buyer_tax=?1 AND buyer<>'' UNION SELECT seller FROM invoices WHERE seller_tax=?1 AND seller<>'' LIMIT 1");
                if let Some(v) = tx.query_row(&sql, [&tax], |r| r.get::<_, String>(0)).optional()? {
                    *name = v;
                }
            }
        }
        let dedup = if p.number.is_empty() {
            format!("h:{}", f.hash)
        } else if p.number.len() < 20 {
            format!("{}|{}|{}", p.number, p.date, p.amount.unwrap_or(-1))
        } else {
            p.number.clone()
        };
        let old: Option<(i64, String, bool)> = tx.query_row("SELECT id, source, edited FROM invoices WHERE dedup=?", [&dedup], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
        let check = needs_check(&p.number, &p.date, p.amount, &p.buyer, &p.seller);
        let id = match old {
            None => {
                tx.execute(
                    "INSERT INTO invoices(dedup, number, issue_date, amount, tax, seller, seller_tax, buyer, buyer_tax, kind, source, needs_check, created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    params![dedup, p.number, p.date, p.amount, p.tax, p.seller, p.seller_tax, p.buyer, p.buyer_tax, p.kind, p.source, check, now()],
                )?;
                tx.last_insert_rowid()
            }
            Some((id, src, edited)) => {
                if !edited && rank(p.source) >= rank(&src) {
                    tx.execute(
                        "UPDATE invoices SET number=?, issue_date=?, amount=?, tax=?, seller=?, seller_tax=?, buyer=?, buyer_tax=?, kind=?, source=?, needs_check=? WHERE id=?",
                        params![p.number, p.date, p.amount, p.tax, p.seller, p.seller_tax, p.buyer, p.buyer_tax, p.kind, p.source, check, id],
                    )?;
                }
                id
            }
        };
        for (idx, inner, name, ext, size) in &f.files {
            tx.execute(
                "INSERT OR IGNORE INTO invoice_files(invoice_id, msg_id, account_id, att_idx, inner, name, ext, role, size, msg_date) VALUES(?,?,?,?,?,?,?, 'invoice', ?, ?)",
                params![id, msg_id, account_id, *idx as i64, inner, name, ext, *size as i64, msg_date],
            )?;
        }
    }
    for (idx, inner, name, ext, size) in extras {
        tx.execute(
            "INSERT OR IGNORE INTO invoice_files(invoice_id, msg_id, account_id, att_idx, inner, name, ext, role, size, msg_date) VALUES(NULL,?,?,?,?,?,?, 'extra', ?, ?)",
            params![msg_id, account_id, *idx as i64, inner, name, ext, *size as i64, msg_date],
        )?;
    }
    tx.execute("INSERT OR REPLACE INTO invoice_scans(msg_id, ver, at) VALUES(?,?,?)", params![msg_id, SCAN_VER, now()])?;
    // 一个文件都不剩的发票（来源邮件删了）：没改过、没隐藏、没在项目里手动调整过的清掉；其余留着，邮件再回来时按发票号接上
    tx.execute("DELETE FROM invoices WHERE edited=0 AND hidden=0 AND id NOT IN (SELECT invoice_id FROM invoice_files WHERE invoice_id IS NOT NULL) AND id NOT IN (SELECT invoice_id FROM invoice_project_items)", [])?;
    tx.commit()
}

/// 同一时间只扫一封（读 PDF 要起子进程，别一下子起一堆）
static SCAN_LOCK: Mutex<()> = Mutex::new(());
/// 有 PDF 这次没读出字（子进程崩了 / 超时）时，这封邮件最多再试几次
const PDF_TRIES: i64 = 3;

/// 扫一封邮件并入库。已经按当前规则扫过的直接跳过（同一封被排了两次也只扫一次）。
/// 有 PDF 这次没读出字：先不算扫完（invoice_scans.ver 记成负的次数），下次再试，试满 PDF_TRIES 次才定下来；
/// 这封以前扫出过东西的，没读出字的这几次不动原来的结果
pub fn scan_message(ctx: &Ctx, msg_id: i64) -> Result<usize> {
    let _g = SCAN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (path, account_id, date, tries, had) = {
        let st = ctx.store.lock().unwrap();
        let row: Option<(i64, i64, bool)> = st.conn.query_row("SELECT account_id, date, has_body FROM messages WHERE id=?", [msg_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
        let Some((acc, date, has_body)) = row else { return Ok(0) };
        if !has_body {
            return Ok(0);
        }
        let ver: Option<i64> = st.conn.query_row("SELECT ver FROM invoice_scans WHERE msg_id=?", [msg_id], |r| r.get(0)).optional()?;
        if ver == Some(SCAN_VER) {
            return Ok(0);
        }
        let had: bool = st.conn.query_row("SELECT EXISTS(SELECT 1 FROM invoice_files WHERE msg_id=?)", [msg_id], |r| r.get(0))?;
        (st.eml_path(msg_id), acc, date, ver.filter(|v| *v < 0).map(|v| -v).unwrap_or(0), had)
    };
    let raw = std::fs::read(&path).map_err(|_| anyhow!("{}", crate::i18n::t("邮件原文还没下载", "The original email hasn't been downloaded yet")))?;
    let (found, extras, unreadable) = scan_raw(&raw, &pdf_text);
    let last_try = !unreadable || tries + 1 >= PDF_TRIES;
    let st = ctx.store.lock().unwrap();
    if last_try || !had {
        save_scan(&st.conn, msg_id, account_id, date, &found, &extras)?;
    }
    if !last_try {
        st.conn.execute("INSERT OR REPLACE INTO invoice_scans(msg_id, ver, at) VALUES(?,?,?)", params![msg_id, -(tries + 1), now()])?;
    }
    Ok(found.len())
}

/// 正文刚下载完的邮件：带 PDF / XML / OFD / 压缩包附件的，叫后台那一个扫描线程来看（不为每封邮件各起一个线程）
pub fn on_body(ctx: &Arc<Ctx>, atts: &[mime::AttInfo]) {
    if atts.iter().any(|a| !a.inline && ["pdf", "xml", "ofd", "zip"].contains(&ext_of(&a.name).as_str())) {
        let _ = sync(ctx);
    }
}

/// 后台扫描线程在不在跑；跑的时候又有人叫它（来了新邮件）就记一笔，这一轮扫完接着再看一轮
static SYNCING: Mutex<bool> = Mutex::new(false);
static AGAIN: Mutex<bool> = Mutex::new(false);

/// 不管扫描线程怎么结束（正常、出错、崩了），都把「在跑」的标记放下来
struct SyncGuard;
impl Drop for SyncGuard {
    fn drop(&mut self) {
        *SYNCING.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }
}

/// 还没扫过（或者是用旧规则扫的、或者上次有 PDF 没读出来还要再试）、带相关附件的邮件
fn pending_ids(conn: &Connection) -> rusqlite::Result<Vec<i64>> {
    let mut q = conn.prepare(
        "SELECT m.id FROM messages m LEFT JOIN invoice_scans s ON s.msg_id=m.id
         WHERE m.has_body=1 AND m.has_att=1 AND (s.msg_id IS NULL OR s.ver<?1)
           AND (lower(m.att_json) LIKE '%.pdf%' OR lower(m.att_json) LIKE '%.xml%' OR lower(m.att_json) LIKE '%.ofd%' OR lower(m.att_json) LIKE '%.zip%')
         ORDER BY m.date DESC",
    )?;
    let v = q.query_map([SCAN_VER], |r| r.get(0))?.collect::<rusqlite::Result<Vec<i64>>>()?;
    Ok(v)
}

/// 把还没扫过的邮件在后台扫完（打开发票台账、来了带附件的新邮件时调）。返回还要扫几封。
/// 只有一个扫描线程：已经在扫就只记一笔「扫完再看一轮」
pub fn sync(ctx: &Arc<Ctx>) -> Result<usize> {
    let n = pending_ids(&ctx.store.lock().unwrap().conn)?.len();
    if n == 0 {
        return Ok(0);
    }
    {
        let mut on = SYNCING.lock().unwrap_or_else(|e| e.into_inner());
        if *on {
            *AGAIN.lock().unwrap_or_else(|e| e.into_inner()) = true;
            return Ok(n);
        }
        *on = true;
    }
    let ctx = ctx.clone();
    std::thread::spawn(move || {
        let _guard = SyncGuard;
        // 一轮扫完再查一遍有没有新的；有 PDF 没读出来的邮件每轮只试一次，所以最多转 PDF_TRIES + 2 轮
        for _ in 0..PDF_TRIES + 2 {
            *AGAIN.lock().unwrap_or_else(|e| e.into_inner()) = false;
            let ids = match pending_ids(&ctx.store.lock().unwrap().conn) {
                Ok(v) => v,
                Err(_) => break,
            };
            if ids.is_empty() {
                break;
            }
            for (i, id) in ids.iter().enumerate() {
                if let Err(e) = scan_message(&ctx, *id) {
                    crate::applog::warn(&format!("发票台账：邮件 {id} 没扫成：{e}"));
                }
                if i % 5 == 4 {
                    let _ = ctx.app.emit("invoice-changed", serde_json::json!({ "kind": "scan", "left": ids.len() - i - 1 }));
                }
            }
            if !*AGAIN.lock().unwrap_or_else(|e| e.into_inner()) && pending_ids(&ctx.store.lock().unwrap().conn).map(|v| v.is_empty()).unwrap_or(true) {
                break;
            }
        }
        let _ = ctx.app.emit("invoice-changed", serde_json::json!({ "kind": "scan", "left": 0 }));
    });
    Ok(n)
}

// ───────────────────────── 列表、详情、修改 ─────────────────────────

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    /// 购买方：None 不限；Some("") = 没读出购买方的
    pub buyer: Option<String>,
    pub seller: Option<String>,
    pub account_id: Option<i64>,
    /// 开票日期范围 YYYY-MM-DD（含两头）
    pub from: Option<String>,
    pub to: Option<String>,
    pub q: Option<String>,
    pub only_check: bool,
    pub hidden: bool,
    /// 只看这个项目里的
    pub project: Option<i64>,
}

/// 一个发票项目：存下来的一组条件（都为空的条件 = 不限；四样全空 = 只有手动加进来的）
#[derive(Serialize, Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Project {
    pub id: i64,
    pub name: String,
    /// None 不限；Some("") = 没读出购买方的
    pub buyer: Option<String>,
    pub seller: Option<String>,
    /// 空 = 全部邮箱
    pub accounts: Vec<i64>,
    /// 开票日期范围 YYYY-MM-DD（含两头），空 = 不限
    pub from: String,
    pub to: String,
    /// 现在项目里有几张、合计多少分（列出来时才算）
    pub count: i64,
    pub total: i64,
}

fn load_project(conn: &Connection, id: i64) -> rusqlite::Result<Option<Project>> {
    conn.query_row("SELECT id, name, buyer, seller, accounts_json, date_from, date_to FROM invoice_projects WHERE id=?", [id], |r| {
        Ok(Project {
            id: r.get(0)?,
            name: r.get(1)?,
            buyer: r.get(2)?,
            seller: r.get(3)?,
            accounts: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
            from: r.get(5)?,
            to: r.get(6)?,
            ..Default::default()
        })
    })
    .optional()
}

/// 「在这个项目里」的条件：手动加进来的，或者符合项目条件而且没被手动移出的
fn project_clause(p: &Project, args: &mut Vec<Box<dyn rusqlite::ToSql>>) -> String {
    let mut rule: Vec<String> = vec![];
    let mut rule_args: Vec<Box<dyn rusqlite::ToSql>> = vec![];
    if let Some(b) = &p.buyer {
        rule.push("i.buyer=?".into());
        rule_args.push(Box::new(b.clone()));
    }
    if let Some(s) = &p.seller {
        rule.push("i.seller=?".into());
        rule_args.push(Box::new(s.clone()));
    }
    if !p.accounts.is_empty() {
        rule.push("EXISTS(SELECT 1 FROM invoice_files x WHERE x.invoice_id=i.id AND x.account_id IN (SELECT value FROM json_each(?)))".into());
        rule_args.push(Box::new(serde_json::to_string(&p.accounts).unwrap_or_else(|_| "[]".into())));
    }
    if is_date(&p.from) {
        rule.push("i.issue_date>=?".into());
        rule_args.push(Box::new(p.from.clone()));
    }
    if is_date(&p.to) {
        rule.push("i.issue_date<>'' AND i.issue_date<=?".into());
        rule_args.push(Box::new(p.to.clone()));
    }
    args.push(Box::new(p.id));
    // 一个条件都没有的项目：只有手动加进来的
    let rule_sql = if rule.is_empty() { "0".to_string() } else { rule.join(" AND ") };
    args.extend(rule_args);
    args.push(Box::new(p.id));
    format!("(i.id IN (SELECT invoice_id FROM invoice_project_items WHERE project_id=? AND mode=1) OR (({rule_sql}) AND i.id NOT IN (SELECT invoice_id FROM invoice_project_items WHERE project_id=? AND mode=0)))")
}

/// 全部项目，带每个项目现在有几张、合计多少（隐藏的发票不算）
pub fn projects(conn: &Connection) -> rusqlite::Result<Vec<Project>> {
    let ids: Vec<i64> = {
        let mut q = conn.prepare("SELECT id FROM invoice_projects ORDER BY created DESC, id DESC")?;
        let v = q.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<i64>>>()?;
        v
    };
    let mut out = vec![];
    for id in ids {
        let Some(mut p) = load_project(conn, id)? else { continue };
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![];
        let clause = project_clause(&p, &mut args);
        let (n, t): (i64, i64) = conn.query_row(
            &format!("SELECT COUNT(*), COALESCE(SUM(i.amount), 0) FROM invoices i WHERE i.hidden=0 AND EXISTS(SELECT 1 FROM invoice_files x WHERE x.invoice_id=i.id) AND {clause}"),
            rusqlite::params_from_iter(args.iter().map(|a| a.as_ref())),
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        p.count = n;
        p.total = t;
        out.push(p);
    }
    Ok(out)
}

/// 新建（id = 0）或修改一个项目，返回它的编号。名字不能空
pub fn save_project(conn: &Connection, p: &Project) -> rusqlite::Result<Option<i64>> {
    let name = clean(&p.name, 60);
    if name.is_empty() {
        return Ok(None);
    }
    let opt = |v: &Option<String>| v.as_ref().map(|x| clean(x, 120));
    let date = |d: &str| if is_date(d) { d.to_string() } else { String::new() };
    let (mut from, mut to) = (date(&p.from), date(&p.to));
    if !from.is_empty() && !to.is_empty() && from > to {
        std::mem::swap(&mut from, &mut to);
    }
    let accounts = serde_json::to_string(&p.accounts).unwrap_or_else(|_| "[]".into());
    if p.id == 0 {
        conn.execute(
            "INSERT INTO invoice_projects(name, buyer, seller, accounts_json, date_from, date_to, created) VALUES(?,?,?,?,?,?,?)",
            params![name, opt(&p.buyer), opt(&p.seller), accounts, from, to, now()],
        )?;
        return Ok(Some(conn.last_insert_rowid()));
    }
    let n = conn.execute(
        "UPDATE invoice_projects SET name=?, buyer=?, seller=?, accounts_json=?, date_from=?, date_to=? WHERE id=?",
        params![name, opt(&p.buyer), opt(&p.seller), accounts, from, to, p.id],
    )?;
    Ok((n > 0).then_some(p.id))
}

pub fn delete_project(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM invoice_project_items WHERE project_id=?", [id])?;
    tx.execute("DELETE FROM invoice_projects WHERE id=?", [id])?;
    tx.commit()
}

/// 手动把一张发票加进项目（add）、移出项目（remove）、或者撤掉手动调整、回到按条件算（reset）
pub fn project_item(conn: &Connection, project: i64, invoice: i64, action: &str) -> rusqlite::Result<bool> {
    match action {
        "add" | "remove" => conn.execute("INSERT OR REPLACE INTO invoice_project_items(project_id, invoice_id, mode) VALUES(?,?,?)", params![project, invoice, (action == "add") as i32]).map(|_| true),
        "reset" => conn.execute("DELETE FROM invoice_project_items WHERE project_id=? AND invoice_id=?", params![project, invoice]).map(|_| true),
        _ => Ok(false),
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: i64,
    pub number: String,
    pub date: String,
    pub amount: Option<i64>,
    pub tax: Option<i64>,
    pub seller: String,
    pub buyer: String,
    pub kind: String,
    pub source: String,
    pub needs_check: bool,
    pub edited: bool,
    pub hidden: bool,
    /// 来自几封邮件（>1 = 重复收到过）
    pub mails: i64,
    pub accounts: Vec<i64>,
    pub has_pdf: bool,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// 最多 2000 行（按开票日期从新到旧）；count 才是当前筛选下的总张数
    pub items: Vec<Row>,
    pub count: i64,
    /// 当前筛选下：合计（分，没读出金额的不计）、没读出金额的张数
    pub total: i64,
    pub no_amount: i64,
    /// 全部（没隐藏的）发票里的购买方 / 销售方 / 账号 / 月份和各自张数，给筛选用；check 在看某个项目时只数项目里的
    pub buyers: Vec<(String, i64)>,
    pub sellers: Vec<(String, i64)>,
    pub accounts: Vec<(i64, i64)>,
    pub months: Vec<(String, i64)>,
    pub all: i64,
    pub check: i64,
    pub hidden: i64,
    pub projects: Vec<Project>,
}

fn is_date(s: &str) -> bool {
    s.len() == 10 && norm_date(s) == s
}

pub fn list(conn: &Connection, f: &Filter) -> rusqlite::Result<Listing> {
    const HAS_FILE: &str = "EXISTS(SELECT 1 FROM invoice_files x WHERE x.invoice_id=i.id)";
    let mut wh = vec![HAS_FILE.to_string(), format!("i.hidden={}", f.hidden as i32)];
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![];
    if let Some(b) = &f.buyer {
        wh.push("i.buyer=?".into());
        args.push(Box::new(b.clone()));
    }
    if let Some(s) = &f.seller {
        wh.push("i.seller=?".into());
        args.push(Box::new(s.clone()));
    }
    if let Some(a) = f.account_id {
        wh.push("EXISTS(SELECT 1 FROM invoice_files x WHERE x.invoice_id=i.id AND x.account_id=?)".into());
        args.push(Box::new(a));
    }
    if let Some(d) = f.from.as_ref().filter(|d| is_date(d)) {
        wh.push("i.issue_date>=?".into());
        args.push(Box::new(d.clone()));
    }
    if let Some(d) = f.to.as_ref().filter(|d| is_date(d)) {
        wh.push("i.issue_date<>'' AND i.issue_date<=?".into());
        args.push(Box::new(d.clone()));
    }
    if let Some(q) = f.q.as_ref().map(|q| q.trim()).filter(|q| !q.is_empty()) {
        wh.push(r"(i.number LIKE ? ESCAPE '\' OR i.seller LIKE ? ESCAPE '\' OR i.buyer LIKE ? ESCAPE '\')".into());
        let like = format!("%{}%", q.replace('\\', r"\\").replace('%', r"\%").replace('_', r"\_"));
        for _ in 0..3 {
            args.push(Box::new(like.clone()));
        }
    }
    if f.only_check {
        wh.push("i.needs_check=1".into());
    }
    // 在项目里看时，「待核对」只数这个项目里的
    let mut check_in_project: Option<i64> = None;
    let mut hidden_in_project: Option<i64> = None;
    if let Some(pid) = f.project {
        match load_project(conn, pid)? {
            Some(p) => {
                let mut a: Vec<Box<dyn rusqlite::ToSql>> = vec![];
                let clause = project_clause(&p, &mut a);
                check_in_project = Some(conn.query_row(
                    &format!("SELECT COUNT(*) FROM invoices i WHERE {HAS_FILE} AND i.hidden=0 AND i.needs_check=1 AND {clause}"),
                    rusqlite::params_from_iter(a.iter().map(|x| x.as_ref())),
                    |r| r.get(0),
                )?);
                hidden_in_project = Some(conn.query_row(
                    &format!("SELECT COUNT(*) FROM invoices i WHERE {HAS_FILE} AND i.hidden=1 AND {clause}"),
                    rusqlite::params_from_iter(a.iter().map(|x| x.as_ref())),
                    |r| r.get(0),
                )?);
                wh.push(project_clause(&p, &mut args));
            }
            None => wh.push("0".into()),
        }
    }
    let sql = format!(
        "SELECT i.id, i.number, i.issue_date, i.amount, i.tax, i.seller, i.buyer, i.kind, i.source, i.needs_check, i.edited, i.hidden,
                (SELECT COUNT(DISTINCT x.msg_id) FROM invoice_files x WHERE x.invoice_id=i.id),
                (SELECT group_concat(DISTINCT x.account_id) FROM invoice_files x WHERE x.invoice_id=i.id),
                EXISTS(SELECT 1 FROM invoice_files x WHERE x.invoice_id=i.id AND x.ext='pdf')
         FROM invoices i WHERE {} ORDER BY i.issue_date DESC, i.id DESC LIMIT 2000",
        wh.join(" AND ")
    );
    let (count, total, no_amount): (i64, i64, i64) = conn.query_row(
        &format!("SELECT COUNT(*), COALESCE(SUM(i.amount), 0), COALESCE(SUM(i.amount IS NULL), 0) FROM invoices i WHERE {}", wh.join(" AND ")),
        rusqlite::params_from_iter(args.iter().map(|a| a.as_ref())),
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let mut q = conn.prepare(&sql)?;
    let items = q
        .query_map(rusqlite::params_from_iter(args.iter().map(|a| a.as_ref())), |r| {
            Ok(Row {
                id: r.get(0)?,
                number: r.get(1)?,
                date: r.get(2)?,
                amount: r.get(3)?,
                tax: r.get(4)?,
                seller: r.get(5)?,
                buyer: r.get(6)?,
                kind: r.get(7)?,
                source: r.get(8)?,
                needs_check: r.get(9)?,
                edited: r.get(10)?,
                hidden: r.get(11)?,
                mails: r.get(12)?,
                accounts: r.get::<_, Option<String>>(13)?.unwrap_or_default().split(',').filter_map(|x| x.parse().ok()).collect(),
                has_pdf: r.get(14)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let vis = format!("FROM invoices i WHERE {HAS_FILE} AND i.hidden=0");
    let pairs = |sql: String| -> rusqlite::Result<Vec<(String, i64)>> {
        let mut q = conn.prepare(&sql)?;
        let v = q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect();
        v
    };
    let one = |sql: String| -> rusqlite::Result<i64> { conn.query_row(&sql, [], |r| r.get(0)) };
    let mut accounts = vec![];
    {
        let mut q = conn.prepare("SELECT x.account_id, COUNT(DISTINCT x.invoice_id) FROM invoice_files x JOIN invoices i ON i.id=x.invoice_id WHERE i.hidden=0 GROUP BY x.account_id ORDER BY 2 DESC")?;
        for r in q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))? {
            accounts.push(r?);
        }
    }
    Ok(Listing {
        count,
        total,
        no_amount,
        items,
        buyers: pairs(format!("SELECT i.buyer, COUNT(*) {vis} GROUP BY i.buyer ORDER BY 2 DESC, 1"))?,
        sellers: pairs(format!("SELECT i.seller, COUNT(*) {vis} GROUP BY i.seller ORDER BY 2 DESC, 1"))?,
        accounts,
        months: pairs(format!("SELECT substr(i.issue_date, 1, 7), COUNT(*) {vis} AND i.issue_date<>'' GROUP BY 1 ORDER BY 1 DESC"))?,
        all: one(format!("SELECT COUNT(*) {vis}"))?,
        check: match check_in_project {
            Some(n) => n,
            None => one(format!("SELECT COUNT(*) {vis} AND i.needs_check=1"))?,
        },
        hidden: match hidden_in_project {
            Some(n) => n,
            None => one(format!("SELECT COUNT(*) FROM invoices i WHERE {HAS_FILE} AND i.hidden=1"))?,
        },
        projects: projects(conn)?,
    })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileOut {
    pub id: i64,
    pub name: String,
    pub ext: String,
    pub size: i64,
    pub msg_id: i64,
    pub role: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MailOut {
    pub msg_id: i64,
    pub account_id: i64,
    pub subject: String,
    pub from: String,
    pub date: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub seller_tax: String,
    pub buyer_tax: String,
    pub files: Vec<FileOut>,
    /// 同一封邮件里不是发票的 PDF（行程单、汇总单、结账单）
    pub extras: Vec<FileOut>,
    pub mails: Vec<MailOut>,
}

fn files_where(conn: &Connection, wh: &str, id: i64) -> rusqlite::Result<Vec<FileOut>> {
    let mut q = conn.prepare(&format!("SELECT id, name, ext, size, msg_id, role FROM invoice_files WHERE {wh} ORDER BY msg_date DESC, CASE ext WHEN 'pdf' THEN 0 WHEN 'ofd' THEN 1 ELSE 2 END, id"))?;
    let v = q.query_map([id], |r| Ok(FileOut { id: r.get(0)?, name: r.get(1)?, ext: r.get(2)?, size: r.get(3)?, msg_id: r.get(4)?, role: r.get(5)? }))?.collect();
    v
}

pub fn detail(conn: &Connection, id: i64) -> rusqlite::Result<Option<Detail>> {
    let Some((seller_tax, buyer_tax)) = conn.query_row("SELECT seller_tax, buyer_tax FROM invoices WHERE id=?", [id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).optional()? else {
        return Ok(None);
    };
    let mut q = conn.prepare(
        "SELECT m.id, m.account_id, m.subject, CASE WHEN m.from_name<>'' THEN m.from_name ELSE m.from_addr END, m.date
         FROM messages m WHERE m.id IN (SELECT msg_id FROM invoice_files WHERE invoice_id=?) ORDER BY m.date DESC",
    )?;
    let mails = q.query_map([id], |r| Ok(MailOut { msg_id: r.get(0)?, account_id: r.get(1)?, subject: r.get(2)?, from: r.get(3)?, date: r.get(4)? }))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(Detail {
        seller_tax,
        buyer_tax,
        files: files_where(conn, "invoice_id=?", id)?,
        extras: files_where(conn, "role='extra' AND msg_id IN (SELECT msg_id FROM invoice_files WHERE invoice_id=?)", id)?,
        mails,
    }))
}

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Patch {
    pub number: Option<String>,
    pub date: Option<String>,
    /// 元，比如 "398.40"；空字符串 = 清掉
    pub amount: Option<String>,
    pub seller: Option<String>,
    pub buyer: Option<String>,
    pub hidden: Option<bool>,
}

/// 手工改一张发票。改过的不再被重新扫描覆盖。发票号改成和另一张一样时拒绝（返回 Ok(false)）
pub fn update(conn: &Connection, id: i64, p: &Patch) -> rusqlite::Result<bool> {
    let tx = conn.unchecked_transaction()?;
    if let Some(h) = p.hidden {
        tx.execute("UPDATE invoices SET hidden=? WHERE id=?", params![h, id])?;
    }
    let touched = p.number.as_ref().is_some_and(|n| !clean(n, 40).is_empty()) || p.date.is_some() || p.amount.is_some() || p.seller.is_some() || p.buyer.is_some();
    if touched {
        if let Some(n) = &p.number {
            let n = clean(n, 40);
            if !n.is_empty() {
                let clash: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM invoices WHERE (dedup=?1 OR number=?1) AND id<>?2)", params![n, id], |r| r.get(0))?;
                if clash {
                    return Ok(false);
                }
                tx.execute("UPDATE invoices SET number=?1 WHERE id=?2", params![n, id])?;
            }
        }
        if let Some(d) = &p.date {
            let d = norm_date(d);
            tx.execute("UPDATE invoices SET issue_date=? WHERE id=?", params![d, id])?;
        }
        if let Some(a) = &p.amount {
            tx.execute("UPDATE invoices SET amount=? WHERE id=?", params![cents(a), id])?;
        }
        if let Some(s) = &p.seller {
            tx.execute("UPDATE invoices SET seller=? WHERE id=?", params![clean(s, 120), id])?;
        }
        if let Some(b) = &p.buyer {
            tx.execute("UPDATE invoices SET buyer=? WHERE id=?", params![clean(b, 120), id])?;
        }
        tx.execute(
            "UPDATE invoices SET edited=1, needs_check=(number='' OR issue_date='' OR amount IS NULL OR buyer='' OR seller='') WHERE id=?",
            [id],
        )?;
    }
    tx.commit()?;
    Ok(true)
}

// ───────────────────────── 取文件、导出 ─────────────────────────

/// 台账里一个文件的内容（从邮件原文里现取；压缩包里的再解一层）
pub fn file_bytes(store: &Mutex<crate::store::Store>, file_id: i64) -> Result<(String, Vec<u8>)> {
    let (path, idx, inner, name) = {
        let st = store.lock().unwrap();
        let (msg_id, idx, inner, name): (i64, i64, String, String) = st.conn.query_row("SELECT msg_id, att_idx, inner, name FROM invoice_files WHERE id=?", [file_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        (st.eml_path(msg_id), idx as usize, inner, name)
    };
    let raw = std::fs::read(&path).map_err(|_| anyhow!("{}", crate::i18n::t("邮件原文还没下载", "The original email hasn't been downloaded yet")))?;
    let (_, data) = mime::attachment_bytes(&raw, idx).ok_or_else(|| anyhow!("{}", crate::i18n::t("找不到这个附件", "Attachment not found")))?;
    if inner.is_empty() {
        return Ok((name, data));
    }
    let mut z = zip_open(&data).ok_or_else(|| anyhow!("{}", crate::i18n::t("压缩包打不开", "Couldn't open the archive")))?;
    let b = zip_read(&mut z, &inner, ZIP_MAX_ONE).ok_or_else(|| anyhow!("{}", crate::i18n::t("压缩包里找不到这个文件", "File not found in the archive")))?;
    Ok((name, b))
}

/// 文件名里不能有的字符换成下划线，去掉看不见的格式字符，限长
pub fn safe_name(s: &str, max: usize) -> String {
    let t: String = s.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) || c.is_control() { '_' } else { c }).filter(|c| !matches!(*c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')).collect();
    let t = t.trim().trim_matches('.').trim();
    let t: String = t.chars().take(max).collect();
    let t = t.trim_end_matches(['.', ' ']).to_string();
    let stem = t.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
    if t.is_empty() {
        "_".into()
    } else if reserved {
        format!("_{t}")
    } else {
        t
    }
}

fn yuan(c: i64) -> String {
    format!("{}{}.{:02}", if c < 0 { "-" } else { "" }, c.abs() / 100, c.abs() % 100)
}

struct ExportRow {
    id: i64,
    number: String,
    date: String,
    amount: Option<i64>,
    tax: Option<i64>,
    seller: String,
    buyer: String,
    kind: String,
    needs_check: bool,
    mails: i64,
    accounts: String,
}

/// 把选中的发票导出成一个压缩包（返回文件名建议和内容）：
///   发票汇总.xlsx、发票/（每张一个 PDF，按「日期_销售方_金额_号码后 8 位」重命名；没有 PDF 的放 OFD）、
///   数据文件/（XML、OFD）、附带材料/（同一封邮件里的行程单、汇总单这些）
pub fn export(store: &Mutex<crate::store::Store>, ids: &[i64], label: &str) -> Result<(String, Vec<u8>, usize)> {
    if ids.is_empty() {
        return Err(anyhow!("{}", crate::i18n::t("没有选中发票", "No invoices selected")));
    }
    let json = serde_json::to_string(ids)?;
    // (file_id, invoice_id 或 0, ext, name, role, msg_id)
    type F = (i64, i64, String, String, String, i64);
    let (rows, files): (Vec<ExportRow>, Vec<F>) = {
        let st = store.lock().unwrap();
        let mut q = st.conn.prepare(
            "SELECT i.id, i.number, i.issue_date, i.amount, i.tax, i.seller, i.buyer, i.kind, i.needs_check,
                    (SELECT COUNT(DISTINCT x.msg_id) FROM invoice_files x WHERE x.invoice_id=i.id),
                    (SELECT group_concat(DISTINCT a.email) FROM invoice_files x JOIN accounts a ON a.id=x.account_id WHERE x.invoice_id=i.id)
             FROM invoices i WHERE i.id IN (SELECT value FROM json_each(?1)) ORDER BY i.issue_date, i.id",
        )?;
        let rows = q
            .query_map([&json], |r| {
                Ok(ExportRow { id: r.get(0)?, number: r.get(1)?, date: r.get(2)?, amount: r.get(3)?, tax: r.get(4)?, seller: r.get(5)?, buyer: r.get(6)?, kind: r.get(7)?, needs_check: r.get(8)?, mails: r.get(9)?, accounts: r.get::<_, Option<String>>(10)?.unwrap_or_default() })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut q = st.conn.prepare(
            "SELECT id, COALESCE(invoice_id, 0), ext, name, role, msg_id FROM invoice_files
             WHERE invoice_id IN (SELECT value FROM json_each(?1))
                OR (role='extra' AND msg_id IN (SELECT msg_id FROM invoice_files WHERE invoice_id IN (SELECT value FROM json_each(?1))))
             ORDER BY msg_date DESC, id",
        )?;
        let files = q.query_map([&json], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        (rows, files)
    };
    let mut zw = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut used: std::collections::HashSet<String> = Default::default();
    let mut uniq = |dir: &str, base: &str, ext: &str| -> String {
        let mut n = format!("{dir}/{base}.{ext}");
        let mut k = 2;
        while !used.insert(n.to_lowercase()) {
            n = format!("{dir}/{base} ({k}).{ext}");
            k += 1;
        }
        n
    };
    let mut file_of: BTreeMap<i64, String> = BTreeMap::new();
    let mut missing = 0usize;
    let mut bytes = 0usize;
    for r in &rows {
        let base = safe_name(
            &format!(
                "{}_{}_{}_{}",
                if r.date.is_empty() { "日期待核对" } else { &r.date },
                if r.seller.is_empty() { "销售方待核对" } else { &r.seller },
                r.amount.map(yuan).unwrap_or_else(|| "金额待核对".into()),
                r.number.chars().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<String>()
            ),
            90,
        );
        // 同一张发票重复收到过：每种文件只放一份（最新那封邮件里的）
        let mut done: std::collections::HashSet<&str> = Default::default();
        let mine: Vec<&F> = files.iter().filter(|f| f.1 == r.id).collect();
        let main_ext = ["pdf", "ofd", "xml"].into_iter().find(|e| mine.iter().any(|f| f.2 == *e)).unwrap_or("pdf");
        let mut failed: std::collections::HashSet<&str> = Default::default();
        for f in mine {
            if done.contains(f.2.as_str()) {
                continue;
            }
            match file_bytes(store, f.0) {
                Ok((_, data)) => {
                    bytes += data.len();
                    if bytes > EXPORT_MAX {
                        return Err(anyhow!("{}", crate::i18n::t("一次导出的文件太多太大了，先按月份或购买方筛小一点再导出", "Too much to export at once; narrow it down by month or buyer first")));
                    }
                    done.insert(f.2.as_str());
                    failed.remove(f.2.as_str());
                    let dir = if f.2 == main_ext { "发票" } else { "数据文件" };
                    let name = uniq(dir, &base, &f.2);
                    zw.start_file(name.as_str(), opt)?;
                    zw.write_all(&data)?;
                    if f.2 == main_ext {
                        file_of.insert(r.id, name);
                    }
                }
                Err(_) => {
                    failed.insert(f.2.as_str());
                }
            }
        }
        missing += failed.len();
    }
    // 附带材料：按来源邮件各放一份
    let mut seen: std::collections::HashSet<(i64, String)> = Default::default();
    for f in files.iter().filter(|f| f.4 == "extra") {
        if !seen.insert((f.5, f.3.clone())) {
            continue;
        }
        if let Ok((_, data)) = file_bytes(store, f.0) {
            let stem = std::path::Path::new(&f.3).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let name = uniq("附带材料", &safe_name(&stem, 80), &f.2);
            zw.start_file(name.as_str(), opt)?;
            zw.write_all(&data)?;
        }
    }
    zw.start_file("发票汇总.xlsx", opt)?;
    zw.write_all(&sheet(&rows, &file_of)?)?;
    let buf = zw.finish()?.into_inner();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M");
    let label = safe_name(label, 40);
    let name = if label == "_" { format!("发票_{}张_{stamp}.zip", rows.len()) } else { format!("发票_{label}_{}张_{stamp}.zip", rows.len()) };
    Ok((name, buf, missing))
}

/// 汇总表：一张发票一行，最后一行合计
fn sheet(rows: &[ExportRow], file_of: &BTreeMap<i64, String>) -> Result<Vec<u8>> {
    use rust_xlsxwriter::{Format, FormatAlign, Workbook};
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("发票汇总")?;
    let head = Format::new().set_bold().set_align(FormatAlign::Center).set_background_color(0xEDEAE3);
    let money = Format::new().set_num_format("#,##0.00");
    let money_b = Format::new().set_num_format("#,##0.00").set_bold();
    let bold = Format::new().set_bold();
    let cols: [(&str, f64); 12] = [("序号", 6.0), ("开票日期", 12.0), ("发票号码", 24.0), ("销售方", 34.0), ("购买方", 34.0), ("不含税金额", 13.0), ("税额", 11.0), ("价税合计", 13.0), ("票种", 16.0), ("收到的邮箱", 28.0), ("文件", 48.0), ("备注", 26.0)];
    for (c, (name, w)) in cols.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, *name, &head)?;
        ws.set_column_width(c as u16, *w)?;
    }
    ws.set_freeze_panes(1, 0)?;
    let (mut sum, mut sum_tax) = (0i64, 0i64);
    for (i, r) in rows.iter().enumerate() {
        let row = (i + 1) as u32;
        ws.write_number(row, 0, (i + 1) as f64)?;
        ws.write_string(row, 1, &r.date)?;
        ws.write_string(row, 2, &r.number)?;
        ws.write_string(row, 3, &r.seller)?;
        ws.write_string(row, 4, &r.buyer)?;
        if let (Some(a), Some(t)) = (r.amount, r.tax) {
            ws.write_number_with_format(row, 5, (a - t) as f64 / 100.0, &money)?;
        }
        if let Some(t) = r.tax {
            ws.write_number_with_format(row, 6, t as f64 / 100.0, &money)?;
            sum_tax += t;
        }
        if let Some(a) = r.amount {
            ws.write_number_with_format(row, 7, a as f64 / 100.0, &money)?;
            sum += a;
        }
        ws.write_string(row, 8, &r.kind)?;
        ws.write_string(row, 9, &r.accounts)?;
        ws.write_string(row, 10, file_of.get(&r.id).map(String::as_str).unwrap_or("（文件没取到）"))?;
        let mut note = vec![];
        if r.needs_check {
            note.push("待核对".to_string());
        }
        if r.mails > 1 {
            note.push(format!("收到过 {} 次，只计一张", r.mails));
        }
        ws.write_string(row, 11, &note.join("；"))?;
    }
    let last = (rows.len() + 1) as u32;
    ws.write_string_with_format(last, 4, &format!("合计（{} 张）", rows.len()), &bold)?;
    ws.write_number_with_format(last, 6, sum_tax as f64 / 100.0, &money_b)?;
    ws.write_number_with_format(last, 7, sum as f64 / 100.0, &money_b)?;
    let no_amount = rows.iter().filter(|r| r.amount.is_none()).count();
    if no_amount > 0 {
        ws.write_string(last, 11, &format!("有 {no_amount} 张没读出金额，未计入合计"))?;
    }
    Ok(wb.save_to_buffer()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?><EInvoice><Header><EIid>26332000009586333546</EIid><InherentLabel><EInvoiceType><LabelCode>02</LabelCode><LabelName>普通发票</LabelName></EInvoiceType></InherentLabel></Header>
<EInvoiceData><SellerInformation><SellerIdNum>91330000SELLER</SellerIdNum><SellerName>杭州卖方科技有限公司</SellerName></SellerInformation>
<BuyerInformation><BuyerIdNum>91330000BUYER</BuyerIdNum><BuyerName>杭州买方食品有限公司</BuyerName></BuyerInformation>
<BasicInformation><TotalAmWithoutTax>100.00</TotalAmWithoutTax><TotalTaxAm>6.00</TotalTaxAm><TotalTax-includedAmount>106.00</TotalTax-includedAmount><RequestTime>2026-11-05 10:00:00</RequestTime></BasicInformation></EInvoiceData></EInvoice>"#;

    #[test]
    fn money_and_dates() {
        assert_eq!(cents("106.00"), Some(10600));
        assert_eq!(cents("1,234.5"), Some(123450));
        assert_eq!(cents("¥88"), Some(8800));
        assert_eq!(cents("-12.34"), Some(-1234));
        assert_eq!(cents(""), None);
        assert_eq!(cents("1.2.3"), None);
        assert_eq!(norm_date("2026-11-05 10:00:00"), "2026-11-05");
        assert_eq!(norm_date("20261105"), "2026-11-05");
        assert_eq!(norm_date("2026年11月5日"), "2026-11-05");
        assert_eq!(norm_date("2026 年 11 月 05 日"), "2026-11-05");
        assert_eq!(norm_date("1999-13-40"), "");
        assert_eq!(yuan(10600), "106.00");
        assert_eq!(yuan(-5), "-0.05");
    }

    #[test]
    fn reads_einvoice_xml() {
        let p = parse_xml(XML.as_bytes()).unwrap();
        assert_eq!(p.number, "26332000009586333546");
        assert_eq!((p.date.as_str(), p.amount, p.tax), ("2026-11-05", Some(10600), Some(600)));
        assert_eq!((p.seller.as_str(), p.buyer.as_str(), p.kind.as_str()), ("杭州卖方科技有限公司", "杭州买方食品有限公司", "普通发票"));
        assert!(parse_xml(b"<root><EIid>1</EIid></root>").is_none());
        assert!(parse_xml(b"not xml").is_none());
    }

    fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opt = zip::write::SimpleFileOptions::default();
        for (n, d) in files {
            zw.start_file(*n, opt).unwrap();
            zw.write_all(d).unwrap();
        }
        zw.finish().unwrap().into_inner()
    }

    #[test]
    fn reads_ofd() {
        let ofd_xml = r#"<?xml version="1.0"?><ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016"><ofd:DocBody><ofd:DocInfo><ofd:CustomDatas>
<ofd:CustomData Name="发票号码">26332000009586333546</ofd:CustomData><ofd:CustomData Name="合计金额">100.00</ofd:CustomData><ofd:CustomData Name="合计税额">6.00</ofd:CustomData>
<ofd:CustomData Name="开票日期">2026年11月05日</ofd:CustomData><ofd:CustomData Name="购买方纳税人识别号">91330000BUYER</ofd:CustomData></ofd:CustomDatas></ofd:DocInfo></ofd:DocBody></ofd:OFD>"#;
        let p = parse_ofd(&zip_of(&[("OFD.xml", ofd_xml.as_bytes()), ("Doc_0/Document.xml", b"<x/>")])).unwrap();
        assert_eq!((p.number.as_str(), p.date.as_str(), p.amount, p.tax, p.buyer_tax.as_str(), p.source), ("26332000009586333546", "2026-11-05", Some(10600), Some(600), "91330000BUYER", "ofd"));
        // OFD 里带着一份数电票数据的：按那份读，名字也有
        let p = parse_ofd(&zip_of(&[("OFD.xml", b"<OFD/>"), ("Doc_0/Tags/Tag.xml", XML.as_bytes())])).unwrap();
        assert_eq!((p.seller.as_str(), p.source), ("杭州卖方科技有限公司", "ofd"));
        // 普通压缩包不是 OFD
        assert!(parse_ofd(&zip_of(&[("a.txt", b"x")])).is_none());
    }

    #[test]
    fn reads_pdf_text() {
        // 标签一堆、数值一堆（真实发票 PDF 读出来的形状）
        let t = "电子发票（普通发票）\n发票号码：\n开票日期：\n购\n买\n方\n名称：\n销\n售\n方\n价税合计（大写）\n（小写）\n26337000000934047756\n2026年11月03日\n杭州卖方科技有限公司\n杭州买方食品有限公司\n¥375.85\n¥22.55\n¥398.40\n";
        let p = parse_pdf_text(t).unwrap();
        assert_eq!((p.number.as_str(), p.date.as_str(), p.amount, p.source), ("26337000000934047756", "2026-11-03", Some(39840), "pdf"));
        assert_eq!((p.buyer.as_str(), p.seller.as_str()), ("杭州卖方科技有限公司", "杭州买方食品有限公司"));
        // 另一种排版：发票号和标签在同一行、单位名写在「名称：」后面、名字结尾带括号
        let t2 = "电子发票（普通发票）\n国家税务总局 发票号码: 26337000000934047756\n开票日期: 2026年11月03日\n购\n名称：杭州买方食品有限公司\n统一社会信用代码/纳税人识别号：91330000BUYER00000\n销\n名称：某某出行科技有限公司（杭州分公司）\n*运输服务*客运服务费 375.85 6% 22.55\n价税合计（大写） （小写）¥398.40\n";
        let p = parse_pdf_text(t2).unwrap();
        assert_eq!((p.number.as_str(), p.date.as_str(), p.amount), ("26337000000934047756", "2026-11-03", Some(39840)));
        assert_eq!((p.buyer.as_str(), p.seller.as_str()), ("杭州买方食品有限公司", "某某出行科技有限公司（杭州分公司）"));
        // 老式电子发票：8 位发票号跟在标签后面；税号（18 位）不会被当成发票号
        let p = parse_pdf_text("增值税电子普通发票\n发票代码：033002100111\n发票号码：12345678\n开票日期：2026年01月02日\n91330000BUYER0000X\n价税合计 ¥10.00").unwrap();
        assert_eq!(p.number, "12345678");
        // 行程单、汇总单、境外英文账单都不是发票
        assert!(parse_pdf_text("滴滴出行-行程单\n发票号码\n开票日期\n¥10.00").is_none());
        assert!(parse_pdf_text("通行费电子票据汇总单（票据）\n26337000000934047756\n价税合计").is_none());
        assert!(parse_pdf_text("ZOHO Corporation\nInvoice\nIssue date\n$375.00").is_none());
        assert!(parse_pdf_text("关于发票的说明\n请查收").is_none());
    }

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE messages(id INTEGER PRIMARY KEY, account_id INTEGER, date INTEGER, has_body INTEGER, has_att INTEGER, att_json TEXT, subject TEXT, from_name TEXT, from_addr TEXT);
             CREATE TABLE accounts(id INTEGER PRIMARY KEY, email TEXT);",
        )
        .unwrap();
        let tx = c.unchecked_transaction().unwrap();
        crate::store::v5_invoices(&tx).unwrap();
        crate::store::v6_invoice_projects(&tx).unwrap();
        tx.commit().unwrap();
        c.execute_batch("INSERT INTO accounts VALUES(1,'a@x.example'),(2,'b@x.example'); INSERT INTO messages VALUES(1,1,100,1,1,'[]','发票','','s@x'),(2,2,200,1,1,'[]','Fw: 发票','','me@x'),(3,1,300,1,1,'[]','酒店发票','','h@x');").unwrap();
        c
    }

    fn found(p: Parsed, files: &[(&str, &str)]) -> Found {
        Found { parsed: p, files: files.iter().enumerate().map(|(i, (n, e))| (files[0].0.bytes().map(|b| b as usize).sum::<usize>() * 10 + i, String::new(), n.to_string(), e.to_string(), 10)).collect(), hash: format!("hash-{}", files[0].0) }
    }

    #[test]
    fn dedup_merge_and_edit() {
        let c = db();
        let xml = parse_xml(XML.as_bytes()).unwrap();
        // 邮件 1：只有 PDF 读出来的同一张发票（两个单位名顺序是反的、没有税额）
        let pdf = Parsed { number: xml.number.clone(), date: "2026-11-05".into(), amount: Some(10600), buyer: "杭州卖方科技有限公司".into(), seller: "杭州买方食品有限公司".into(), source: "pdf", ..Default::default() };
        save_scan(&c, 1, 1, 100, &[found(pdf.clone(), &[("a.pdf", "pdf")])], &[]).unwrap();
        // 邮件 2（另一个邮箱转发来的）：带 XML，同一个发票号 → 并到一张上，用 XML 的信息覆盖
        save_scan(&c, 2, 2, 200, &[found(xml.clone(), &[("a.pdf", "pdf"), ("a.xml", "xml")])], &[(5, String::new(), "行程单.pdf".into(), "pdf".into(), 9)]).unwrap();
        let l = list(&c, &Filter::default()).unwrap();
        assert_eq!((l.items.len(), l.total, l.all), (1, 10600, 1));
        let r = &l.items[0];
        assert_eq!((r.mails, r.source.as_str(), r.buyer.as_str(), r.tax, r.needs_check), (2, "xml", "杭州买方食品有限公司", Some(600), false));
        assert_eq!(r.accounts.len(), 2);
        let d = detail(&c, r.id).unwrap().unwrap();
        assert_eq!((d.files.len(), d.extras.len(), d.mails.len()), (3, 1, 2));
        // 之后再来一张只有 PDF 的、不同号码：已知的购买方名单能把反了的两个名字换回来
        let pdf2 = Parsed { number: "26330000000000000002".into(), date: "2026-11-06".into(), amount: Some(5000), buyer: "某酒店管理有限公司".into(), seller: "杭州买方食品有限公司".into(), source: "pdf", ..Default::default() };
        save_scan(&c, 3, 1, 300, &[found(pdf2, &[("h.pdf", "pdf")])], &[]).unwrap();
        let l = list(&c, &Filter { buyer: Some("杭州买方食品有限公司".into()), ..Default::default() }).unwrap();
        assert_eq!((l.items.len(), l.total), (2, 15600));
        assert_eq!(l.buyers, vec![("杭州买方食品有限公司".to_string(), 2)]);
        // 筛选：日期、邮箱、搜索
        assert_eq!(list(&c, &Filter { from: Some("2026-11-06".into()), ..Default::default() }).unwrap().items.len(), 1);
        assert_eq!(list(&c, &Filter { account_id: Some(2), ..Default::default() }).unwrap().items.len(), 1);
        assert_eq!(list(&c, &Filter { q: Some("酒店".into()), ..Default::default() }).unwrap().items.len(), 1);
        // 手工改：金额改掉后重新扫描不覆盖；发票号改成和别的一样被拒绝
        let id = l.items.iter().find(|x| x.number.ends_with("02")).unwrap().id;
        assert!(update(&c, id, &Patch { amount: Some("66.60".into()), ..Default::default() }).unwrap());
        assert!(!update(&c, id, &Patch { number: Some(xml.number.clone()), ..Default::default() }).unwrap());
        let pdf2b = Parsed { number: "26330000000000000002".into(), date: "2026-11-06".into(), amount: Some(5000), source: "xml", ..Default::default() };
        save_scan(&c, 3, 1, 300, &[found(pdf2b, &[("h.pdf", "pdf")])], &[]).unwrap();
        let l = list(&c, &Filter::default()).unwrap();
        assert_eq!(l.items.iter().find(|x| x.id == id).unwrap().amount, Some(6660));
        // 手工改发票号：之后同一张发票再扫到（读出来的还是原来的号码），还是这一行，不会多出一张
        assert!(update(&c, id, &Patch { number: Some("26330000000000000009".into()), ..Default::default() }).unwrap());
        let pdf2c = Parsed { number: "26330000000000000002".into(), date: "2026-11-06".into(), amount: Some(5000), source: "pdf", ..Default::default() };
        save_scan(&c, 3, 1, 300, &[found(pdf2c, &[("h.pdf", "pdf")])], &[]).unwrap();
        let l = list(&c, &Filter::default()).unwrap();
        assert_eq!(l.items.len(), 2);
        assert_eq!(l.items.iter().find(|x| x.id == id).map(|x| (x.number.as_str(), x.amount)), Some(("26330000000000000009", Some(6660))));
        // 项目：按条件自动归集（购买方 + 日期范围 + 邮箱），手动加进 / 移出，改条件，删除
        let pid = save_project(&c, &Project { name: "11 月报销".into(), buyer: Some("杭州买方食品有限公司".into()), from: "2026-11-06".into(), to: "2026-11-30".into(), ..Default::default() }).unwrap().unwrap();
        assert!(save_project(&c, &Project { name: "  ".into(), ..Default::default() }).unwrap().is_none());
        let in_p = |pid: i64| list(&c, &Filter { project: Some(pid), ..Default::default() }).unwrap().items.iter().map(|x| x.id).collect::<Vec<_>>();
        assert_eq!(in_p(pid), vec![id]);
        let other = l.items.iter().find(|x| x.id != id).unwrap().id;
        assert!(project_item(&c, pid, other, "add").unwrap());
        assert_eq!(in_p(pid).len(), 2);
        assert!(project_item(&c, pid, id, "remove").unwrap());
        assert_eq!(in_p(pid), vec![other]);
        assert!(project_item(&c, pid, id, "reset").unwrap());
        assert!(!project_item(&c, pid, id, "乱写").unwrap());
        assert_eq!(in_p(pid).len(), 2);
        let ps = list(&c, &Filter::default()).unwrap().projects;
        assert_eq!((ps.len(), ps[0].name.as_str(), ps[0].count, ps[0].total), (1, "11 月报销", 2, 10600 + 6660));
        // 只限邮箱：发票在哪个邮箱收到过就算；一个条件都没有的项目只有手动加的
        let p2 = save_project(&c, &Project { name: "邮箱 2".into(), accounts: vec![2], ..Default::default() }).unwrap().unwrap();
        assert_eq!(in_p(p2), vec![other]);
        let p3 = save_project(&c, &Project { name: "手动挑".into(), ..Default::default() }).unwrap().unwrap();
        assert!(in_p(p3).is_empty());
        project_item(&c, p3, id, "add").unwrap();
        assert_eq!(in_p(p3), vec![id]);
        // 改条件、删除；不存在的项目什么都筛不出来
        assert_eq!(save_project(&c, &Project { id: p2, name: "邮箱 1".into(), accounts: vec![1], ..Default::default() }).unwrap(), Some(p2));
        assert_eq!(in_p(p2).len(), 2);
        delete_project(&c, p2).unwrap();
        assert!(in_p(p2).is_empty());
        assert_eq!(list(&c, &Filter::default()).unwrap().projects.len(), 2);
        // 把发票号清空不算改动；搜索里的 % 当普通字符（不会搜出全部）
        assert!(update(&c, 1, &Patch { number: Some("  ".into()), ..Default::default() }).unwrap());
        let e1: bool = c.query_row("SELECT edited FROM invoices WHERE id=1", [], |r| r.get(0)).unwrap();
        assert!(!e1);
        assert_eq!(list(&c, &Filter { q: Some("%".into()), ..Default::default() }).unwrap().count, 0);
        // 老式短发票号：号码一样、日期金额不一样的是两张
        let short = |d: &str, a: i64| Parsed { number: "12345678".into(), date: d.into(), amount: Some(a), source: "pdf", ..Default::default() };
        save_scan(&c, 1, 1, 100, &[found(xml.clone(), &[("a.pdf", "pdf")]), found(short("2026-01-02", 1000), &[("s1.pdf", "pdf")]), found(short("2026-03-04", 2000), &[("s2.pdf", "pdf")])], &[]).unwrap();
        assert_eq!(list(&c, &Filter { q: Some("12345678".into()), ..Default::default() }).unwrap().count, 2);
        save_scan(&c, 1, 1, 100, &[found(xml.clone(), &[("a.pdf", "pdf")])], &[]).unwrap();
        // 隐藏（不是我要的发票）：列表里没了，合计不算
        assert!(update(&c, id, &Patch { hidden: Some(true), ..Default::default() }).unwrap());
        let l = list(&c, &Filter::default()).unwrap();
        assert_eq!((l.items.len(), l.total, l.hidden), (1, 10600, 1));
        // 来源邮件都没了：没改过的发票跟着清掉；改过 / 隐藏的留着
        c.execute("DELETE FROM invoice_files WHERE msg_id IN (1,2)", []).unwrap();
        save_scan(&c, 1, 1, 100, &[], &[]).unwrap();
        let count = || c.query_row::<i64, _, _>("SELECT COUNT(*) FROM invoices", [], |r| r.get(0)).unwrap();
        // 在项目里手动调整过的也留着（邮件回来时接得上，调整不丢），但不显示
        assert!(count() > 1);
        assert_eq!(list(&c, &Filter { project: Some(p3), ..Default::default() }).unwrap().count, 0);
        c.execute("DELETE FROM invoice_project_items", []).unwrap();
        save_scan(&c, 1, 1, 100, &[], &[]).unwrap();
        assert_eq!(count(), 1);
    }

    #[test]
    fn scans_a_real_shaped_mail() {
        // 一封邮件：压缩包里两张发票（各有 PDF + XML + OFD），外面还有一个不是发票的 PDF
        let xml2 = XML.replace("26332000009586333546", "26332000009586333547");
        let z = zip_of(&[("fp/pdf/a.pdf", b"%PDF-1"), ("fp/xml/a.xml", XML.as_bytes()), ("fp/ofd/a.ofd", b"PKxx"), ("fp/pdf/b.pdf", b"%PDF-2"), ("fp/xml/b.xml", xml2.as_bytes()), ("../evil.pdf", b"%PDF-x"), ("readme.txt", b"x")]);
        let b64 = |d: &[u8]| mime::b64(d);
        let raw = format!(
            "From: a@b.c\r\nSubject: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"B\"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nhi\r\n--B\r\nContent-Type: application/zip; name=\"fp.zip\"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=\"fp.zip\"\r\n\r\n{}\r\n--B\r\nContent-Type: application/pdf; name=\"list.pdf\"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=\"list.pdf\"\r\n\r\n{}\r\n--B--\r\n",
            b64(&z),
            b64(b"%PDF-list")
        );
        let (found, extras, _) = scan_raw(raw.as_bytes(), &|_| Some("通行费电子票据汇总单\n价税合计".into()));
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].files.len(), 3);
        assert_eq!(found[1].files.len(), 2);
        assert!(found.iter().all(|f| f.parsed.source == "xml" && f.files.iter().all(|x| x.1.starts_with("fp/"))));
        assert_eq!(extras.len(), 1);
        assert_eq!(extras[0].2, "list.pdf");
        // 一封邮件里三个附件都叫「发票.pdf」/「发票.xml」：是三张，不能并成一张
        let part = |name: &str, d: &[u8]| format!("--B\r\nContent-Type: application/octet-stream; name=\"{name}\"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=\"{name}\"\r\n\r\n{}\r\n", b64(d));
        let xml3 = XML.replace("26332000009586333546", "26332000009586333548");
        let same = format!("From: a@b.c\r\nSubject: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"B\"\r\n\r\n{}{}{}{}{}{}--B--\r\n", part("fp.pdf", b"%PDF-1"), part("fp.xml", XML.as_bytes()), part("fp.pdf", b"%PDF-2"), part("fp.xml", xml2.as_bytes()), part("fp.pdf", b"%PDF-3"), part("fp.xml", xml3.as_bytes()));
        let (f3, _, _) = scan_raw(same.as_bytes(), &|_| None);
        assert_eq!(f3.len(), 3);
        assert!(f3.iter().all(|f| f.files.len() == 2));
        let mut nums: Vec<&str> = f3.iter().map(|f| f.parsed.number.as_str()).collect();
        nums.dedup();
        assert_eq!(nums.len(), 3);
        // PDF 读不出字、但文件名写着发票：记成一张待核对的，不悄悄漏掉；文件名看不出来的不记
        let lone = format!("From: a@b.c\r\nSubject: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"B\"\r\n\r\n{}{}--B--\r\n", part("电子发票.pdf", b"%PDF-1"), part("scan.pdf", b"%PDF-2"));
        let (f4, e4, unread) = scan_raw(lone.as_bytes(), &|_| None);
        assert_eq!((f4.len(), e4.len(), unread), (1, 1, true));
        assert!(f4[0].parsed.number.is_empty() && f4[0].parsed.source == "pdf");
        // 没有发票的邮件：PDF 不算附带材料
        let (f2, e2, _) = scan_raw(raw.replace("fp.zip", "fp.bin").as_bytes(), &|_| None);
        assert!(f2.is_empty() && e2.is_empty());
    }

    /// 拿一个放着真实发票文件的文件夹验一遍（平时不跑；仓库里不放真实发票）：
    ///   KJM_INVOICE_SAMPLES=<文件夹> cargo test --lib real_samples -- --ignored --nocapture
    /// 文件夹里同名的 .pdf / .xml 算一组：有 XML 的拿 XML 当标准答案，看「读 PDF 文字」读得对不对。只打印统计
    #[test]
    #[ignore]
    fn real_samples() {
        let Ok(dir) = std::env::var("KJM_INVOICE_SAMPLES") else { return };
        let mut stat: BTreeMap<String, usize> = BTreeMap::new();
        let mut bump = |k: &str| *stat.entry(k.to_string()).or_default() += 1;
        let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).collect();
        files.sort();
        for p in files.iter().filter(|p| p.extension().is_some_and(|e| e == "pdf")) {
            let truth = std::fs::read(p.with_extension("xml")).ok().and_then(|b| parse_xml(&b));
            let ofd = std::fs::read(p.with_extension("ofd")).ok().and_then(|b| parse_ofd(&b));
            if let (Some(t), Some(o)) = (&truth, &ofd) {
                bump(if o.number == t.number && o.date == t.date && o.amount == t.amount { "OFD 和 XML 一致" } else { "OFD 和 XML 不一致" });
            }
            // 读 PDF 文字：直接调组件（它会崩的文件在这里用 catch_unwind 接住；正式程序里是放在子进程里读）
            let b = std::fs::read(p).unwrap();
            let text = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(&b).ok()).ok().flatten();
            let parsed = text.as_deref().and_then(parse_pdf_text);
            let who = if truth.is_some() { "有 XML" } else { "只有 PDF" };
            match (&text, &parsed, &truth) {
                (None, _, _) => bump(&format!("{who}：PDF 读不出字（组件报错或崩溃）")),
                (Some(_), None, _) => bump(&format!("{who}：读出字了，判断不是发票")),
                (Some(_), Some(p), Some(t)) => bump(&format!("有 XML：PDF 读出来的 号码{} 日期{} 金额{}", if p.number == t.number { "对" } else { "错" }, if p.date == t.date { "对" } else { "错" }, if p.amount == t.amount { "对" } else { "错" })),
                (Some(_), Some(p), None) => bump(&format!("只有 PDF：判成发票，号码{} 日期{} 金额{} 单位名 {} 个", if p.number.is_empty() { "无" } else { "有" }, if p.date.is_empty() { "无" } else { "有" }, if p.amount.is_none() { "无" } else { "有" }, [&p.buyer, &p.seller].iter().filter(|x| !x.is_empty()).count())),
            }
        }
        // 调试用（KJM_DEBUG=1）：OFD 读不出来的原因；只有 PDF 的发票读出来的文字形状（汉字打成「中」、数字打成 9）
        if std::env::var("KJM_DEBUG").is_ok() {
            if let Some(p) = files.iter().find(|p| p.extension().is_some_and(|e| e == "ofd")) {
                let b = std::fs::read(p).unwrap();
                match zip_open(&b) {
                    None => println!("OFD：当压缩包打不开，开头 {:?}", &b[..4.min(b.len())]),
                    Some(mut z) => {
                        let names: Vec<String> = z.file_names().map(|s| s.to_string()).collect();
                        println!("OFD 里有：{:?}", &names[..names.len().min(6)]);
                        let x = zip_read(&mut z, "OFD.xml", 2 * 1024 * 1024);
                        let parsed = x.as_ref().map(|v| match std::str::from_utf8(v) {
                            Err(e) => format!("不是 UTF-8：{e}"),
                            Ok(t) => match roxmltree::Document::parse(t.trim_start_matches('\u{feff}')) {
                                Err(e) => format!("XML 解析不了：{e}"),
                                Ok(d) => format!("CustomData {} 个", d.descendants().filter(|n| n.tag_name().name() == "CustomData").count()),
                            },
                        });
                        println!("OFD.xml 读到 {:?} 字节；{:?}", x.as_ref().map(|v| v.len()), parsed);
                        println!("OFD 整体读出来：{:?}；同名 XML 在不在：{}", parse_ofd(&b).map(|o| (o.number.len(), o.date, o.amount.is_some(), o.buyer_tax.len())), p.with_extension("xml").exists());
                    }
                }
            }
            for p in files.iter().filter(|p| p.extension().is_some_and(|e| e == "pdf") && !p.with_extension("xml").exists()) {
                let b = std::fs::read(p).unwrap();
                if let Some(t) = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(&b).ok()).ok().flatten() {
                    if let Some(pp) = parse_pdf_text(&t) {
                        let mask: String = t.chars().take(420).map(|c| if c.is_ascii_digit() { '9' } else if ('\u{4e00}'..='\u{9fff}').contains(&c) { '中' } else { c }).collect();
                        println!("--- 号码{} 单位名{}个：{:?}", if pp.number.is_empty() { "无" } else { "有" }, [&pp.buyer, &pp.seller].iter().filter(|x| !x.is_empty()).count(), mask);
                    }
                }
            }
        }
        for (k, v) in stat {
            println!("{v:4}  {k}");
        }
    }

    /// 在真实邮箱数据的**副本**上整条跑一遍（平时不跑）。先把数据目录（kojoomail.db* 和 mail/）复制到一个临时文件夹，再：
    ///   KJM_REAL_COPY=<副本文件夹> cargo test --lib real_mailbox -- --ignored --nocapture
    /// 会在副本上升级数据库、扫描全部带附件的邮件、列出台账、导出压缩包到副本文件夹里。只打印统计，不打印发票内容
    #[test]
    #[ignore]
    fn real_mailbox() {
        let Ok(dir) = std::env::var("KJM_REAL_COPY") else { return };
        let dir = std::path::PathBuf::from(dir);
        let store = Mutex::new(crate::store::Store::open(&dir).unwrap());
        let ids = pending_ids(&store.lock().unwrap().conn).unwrap();
        println!("要看的邮件（带 PDF / XML / OFD / 压缩包附件、原文已下载）：{} 封", ids.len());
        let pdf = |b: &[u8]| -> Option<String> { let b = b.to_vec(); std::panic::catch_unwind(move || pdf_extract::extract_text_from_mem(&b).ok()).ok().flatten() };
        let t0 = std::time::Instant::now();
        let (mut with, mut inv, mut ext) = (0, 0, 0);
        for id in &ids {
            let (path, acc, date) = {
                let st = store.lock().unwrap();
                let (acc, date): (i64, i64) = st.conn.query_row("SELECT account_id, date FROM messages WHERE id=?", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
                (st.eml_path(*id), acc, date)
            };
            let Ok(raw) = std::fs::read(&path) else { continue };
            let (found, extras, _) = scan_raw(&raw, &pdf);
            if !found.is_empty() {
                with += 1;
            }
            inv += found.len();
            ext += extras.len();
            save_scan(&store.lock().unwrap().conn, *id, acc, date, &found, &extras).unwrap();
        }
        println!("扫完用时 {:?}：{} 封邮件里有发票，发票文件组 {} 个，附带材料 {} 个", t0.elapsed(), with, inv, ext);
        let l = list(&store.lock().unwrap().conn, &Filter::default()).unwrap();
        let by = |f: &dyn Fn(&Row) -> bool| l.items.iter().filter(|r| f(r)).count();
        println!("台账：{} 张（去重后），合计 {}，没读出金额 {} 张，待核对 {} 张", l.items.len(), yuan(l.total), l.no_amount, l.check);
        println!("  信息来源：XML {} / OFD {} / PDF 文字 {}；重复收到过的 {} 张（最多的一张收到 {} 次）", by(&|r| r.source == "xml"), by(&|r| r.source == "ofd"), by(&|r| r.source == "pdf"), by(&|r| r.mails > 1), l.items.iter().map(|r| r.mails).max().unwrap_or(0));
        println!("  购买方 {} 个（各 {:?} 张），销售方 {} 个，月份 {:?}，涉及邮箱 {} 个", l.buyers.len(), l.buyers.iter().map(|b| b.1).collect::<Vec<_>>(), l.sellers.len(), l.months, l.accounts.len());
        println!("  再扫一遍还剩 {} 封没扫", pending_ids(&store.lock().unwrap().conn).unwrap().len());
        // 按最大的购买方筛出来导出
        let top = l.buyers.first().map(|b| b.0.clone());
        let fl = list(&store.lock().unwrap().conn, &Filter { buyer: top, ..Default::default() }).unwrap();
        let ids: Vec<i64> = fl.items.iter().map(|r| r.id).collect();
        let (name, data, missing) = export(&store, &ids, "").unwrap();
        let out = dir.join("export-test.zip");
        std::fs::write(&out, &data).unwrap();
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(&data[..])).unwrap();
        let mut dirs: BTreeMap<String, usize> = BTreeMap::new();
        for n in z.file_names() {
            *dirs.entry(n.split('/').next().unwrap_or("").to_string()).or_default() += 1;
        }
        let sheet = zip_read(&mut z, "发票汇总.xlsx", 10 * 1024 * 1024).map(|b| b.len());
        println!("导出（最大的购买方，{} 张）：文件名形如 {}，{} KB，没取到的文件 {} 个；压缩包里 {:?}；汇总表 {:?} 字节", ids.len(), name.chars().map(|c| if c.is_ascii_digit() { '9' } else { c }).collect::<String>(), data.len() / 1024, missing, dirs, sheet);
        // 再扫一遍不应该多出发票（重复扫描结果一样）
        let before = l.items.len();
        store.lock().unwrap().conn.execute("DELETE FROM invoice_scans", []).unwrap();
        // 先把要扫的编号取出来再循环（写在 for 开头的话，数据库的锁会一直拿到循环结束，循环里再拿就卡死）
        let again_ids = pending_ids(&store.lock().unwrap().conn).unwrap();
        for id in again_ids {
            let (path, acc, date) = {
                let st = store.lock().unwrap();
                let (acc, date): (i64, i64) = st.conn.query_row("SELECT account_id, date FROM messages WHERE id=?", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
                (st.eml_path(id), acc, date)
            };
            if let Ok(raw) = std::fs::read(&path) {
                let (found, extras, _) = scan_raw(&raw, &pdf);
                save_scan(&store.lock().unwrap().conn, id, acc, date, &found, &extras).unwrap();
            }
        }
        let again = list(&store.lock().unwrap().conn, &Filter::default()).unwrap();
        println!("全部重扫一遍：{} 张 → {} 张，合计 {} → {}", before, again.items.len(), yuan(l.total), yuan(again.total));
        assert_eq!((before, l.total), (again.items.len(), again.total));
    }

    #[test]
    fn names_are_safe() {
        assert_eq!(safe_name("2026-11-03_滴滴/出行:有限公司_398.40", 90), "2026-11-03_滴滴_出行_有限公司_398.40");
        assert_eq!(safe_name("..", 10), "_");
        assert_eq!(safe_name("a\u{202E}b.", 10), "ab");
        assert_eq!(safe_name("CON", 10), "_CON");
        assert_eq!(safe_name("com1.pdf", 10), "_com1.pdf");
        assert_eq!(safe_name("abc. ", 10), "abc");
    }
}

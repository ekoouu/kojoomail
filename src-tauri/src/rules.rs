//! 邮件规则：新邮件到达收件箱时按顺序匹配，执行移动 / 归档 / 垃圾邮件 / 已读未读 / 重点。
//! 只在 mailbox.rs 的 sync_folder 里对这次新插入的收件箱邮件跑一次；动作全部走现有的 Op::Flags / Op::Move。
//! 第一期故意不支持删除和移到「已删除」（validate 拦着）。

use crate::mailbox::Op;
use crate::mime::Addr;
use crate::store::now;
use crate::Ctx;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use tauri::State;

type Res<T> = Result<T, String>;
fn e<E: std::fmt::Display>(x: E) -> String {
    x.to_string()
}

const FIELDS: [&str; 4] = ["from", "to", "subject", "attachment"];
const TEXT_OPS: [&str; 3] = ["contains", "not_contains", "equals"];
const ATT_OPS: [&str; 2] = ["has", "none"];
const KINDS: [&str; 7] = ["move", "archive", "junk", "read", "unread", "flag", "unflag"];
const MAX_RULES: i64 = 100;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Cond {
    pub field: String,
    pub op: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub kind: String,
    /// kind=move 时是目标文件夹的 path
    #[serde(default)]
    pub folder: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    pub enabled: bool,
    /// None = 所有账号
    pub account_id: Option<i64>,
    pub match_all: bool,
    pub conds: Vec<Cond>,
    pub actions: Vec<Action>,
    pub stop: bool,
}

/// 匹配用的邮件信息（只用邮件头里有的）
pub struct MsgView {
    pub from_name: String,
    pub from_addr: String,
    pub to: Vec<Addr>,
    pub subject: String,
    pub has_att: bool,
}

fn person(name: &str, addr: &str) -> String {
    format!("{} {}", name, addr).to_lowercase()
}

fn cond_hit(c: &Cond, m: &MsgView) -> bool {
    let v = c.value.trim().to_lowercase();
    match c.field.as_str() {
        "from" => {
            let who = person(&m.from_name, &m.from_addr);
            match c.op.as_str() {
                "contains" => who.contains(&v),
                "not_contains" => !who.contains(&v),
                "equals" => m.from_addr.trim().to_lowercase() == v,
                _ => false,
            }
        }
        "to" => match c.op.as_str() {
            "contains" => m.to.iter().any(|a| person(&a.name, &a.email).contains(&v)),
            "not_contains" => m.to.iter().all(|a| !person(&a.name, &a.email).contains(&v)),
            "equals" => m.to.iter().any(|a| a.email.trim().to_lowercase() == v),
            _ => false,
        },
        "subject" => {
            let s = m.subject.to_lowercase();
            match c.op.as_str() {
                "contains" => s.contains(&v),
                "not_contains" => !s.contains(&v),
                "equals" => s.trim() == v,
                _ => false,
            }
        }
        "attachment" => match c.op.as_str() {
            "has" => m.has_att,
            "none" => !m.has_att,
            _ => false,
        },
        _ => false,
    }
}

/// 这条规则的条件是否命中（不看 enabled / 账号）。没有条件一律不命中
pub fn matches(rule: &Rule, m: &MsgView) -> bool {
    if rule.conds.is_empty() {
        return false;
    }
    if rule.match_all {
        rule.conds.iter().all(|c| cond_hit(c, m))
    } else {
        rule.conds.iter().any(|c| cond_hit(c, m))
    }
}

fn validate(st: &crate::store::Store, r: &Rule) -> Res<()> {
    if r.name.trim().chars().count() > 80 {
        return Err(crate::i18n::t("规则名最多 80 个字", "Rule name can be at most 80 characters").into());
    }
    if r.conds.is_empty() || r.conds.len() > 10 {
        return Err(crate::i18n::t("条件要有 1 到 10 条", "A rule needs 1 to 10 conditions").into());
    }
    for c in &r.conds {
        if !FIELDS.contains(&c.field.as_str()) {
            return Err(crate::i18n::t("条件的字段不对", "Invalid condition field").into());
        }
        if c.field == "attachment" {
            if !ATT_OPS.contains(&c.op.as_str()) {
                return Err(crate::i18n::t("附件条件的方式不对", "Invalid attachment condition").into());
            }
        } else {
            if !TEXT_OPS.contains(&c.op.as_str()) {
                return Err(crate::i18n::t("条件的方式不对", "Invalid condition operator").into());
            }
            let n = c.value.trim().chars().count();
            if n == 0 {
                return Err(crate::i18n::t("条件的内容不能为空", "Condition text can't be empty").into());
            }
            if n > 200 {
                return Err(crate::i18n::t("条件的内容最多 200 个字", "Condition text can be at most 200 characters").into());
            }
        }
    }
    if r.actions.is_empty() || r.actions.len() > 5 {
        return Err(crate::i18n::t("动作要有 1 到 5 个", "A rule needs 1 to 5 actions").into());
    }
    let has = |k: &str| r.actions.iter().any(|a| a.kind == k);
    for a in &r.actions {
        if !KINDS.contains(&a.kind.as_str()) {
            return Err(crate::i18n::t("动作不对", "Invalid action").into());
        }
    }
    if r.actions.iter().filter(|a| matches!(a.kind.as_str(), "move" | "archive" | "junk")).count() > 1 {
        return Err(crate::i18n::t("一条规则只能有一个去向", "A rule can only move mail to one place").into());
    }
    if (has("read") && has("unread")) || (has("flag") && has("unflag")) {
        return Err(crate::i18n::t("动作互相矛盾", "These actions contradict each other").into());
    }
    if let Some(acc) = r.account_id {
        let ok = st.conn.query_row("SELECT 1 FROM accounts WHERE id=?", [acc], |_| Ok(())).is_ok();
        if !ok {
            return Err(crate::i18n::t("这个账号不存在", "This account doesn't exist").into());
        }
    }
    if let Some(a) = r.actions.iter().find(|a| a.kind == "move") {
        let Some(acc) = r.account_id else {
            return Err(crate::i18n::t("移动到文件夹要先选一个具体账号", "Choose a specific account to move mail to a folder").into());
        };
        let role: Option<String> = st
            .conn
            .query_row("SELECT role FROM folders WHERE account_id=? AND path=?", params![acc, a.folder], |r| r.get(0))
            .ok();
        match role.as_deref() {
            None => return Err(crate::i18n::t("目标文件夹不存在", "The target folder doesn't exist").into()),
            Some("inbox" | "trash" | "drafts" | "sent") => {
                return Err(crate::i18n::t("不能移到这个文件夹", "Mail can't be moved to this folder by a rule").into())
            }
            _ => {}
        }
    }
    Ok(())
}

fn read_rules(st: &crate::store::Store, sql: &str, p: &[&dyn rusqlite::ToSql]) -> rusqlite::Result<Vec<Rule>> {
    let mut q = st.conn.prepare(sql)?;
    let v = q
        .query_map(p, |r| {
            let conds_json: String = r.get(5)?;
            let actions_json: String = r.get(6)?;
            let mut enabled: bool = r.get(2)?;
            let parsed = (serde_json::from_str::<Vec<Cond>>(&conds_json), serde_json::from_str::<Vec<Action>>(&actions_json));
            let (conds, actions) = match parsed {
                (Ok(c), Ok(a)) => (c, a),
                _ => {
                    // 解析不了的当作停用，列表里照样显示，用户可以删掉或重新编辑
                    enabled = false;
                    (vec![], vec![])
                }
            };
            Ok(Rule { id: r.get(0)?, name: r.get(1)?, enabled, account_id: r.get(3)?, match_all: r.get(4)?, conds, actions, stop: r.get(7)? })
        })?
        .filter_map(|x| x.ok())
        .collect();
    Ok(v)
}

const SELECT_RULES: &str = "SELECT id, name, enabled, account_id, match_all, conds_json, actions_json, stop FROM rules";

#[tauri::command]
pub async fn rule_list(ctx: State<'_, Arc<Ctx>>) -> Res<Vec<Rule>> {
    let st = ctx.store.lock().unwrap();
    read_rules(&st, &format!("{SELECT_RULES} ORDER BY sort, id"), &[]).map_err(e)
}

#[tauri::command]
pub async fn rule_save(ctx: State<'_, Arc<Ctx>>, rule: Rule) -> Res<i64> {
    let st = ctx.store.lock().unwrap();
    validate(&st, &rule)?;
    let conds = serde_json::to_string(&rule.conds).map_err(e)?;
    let actions = serde_json::to_string(&rule.actions).map_err(e)?;
    let name = rule.name.trim().to_string();
    if rule.id == 0 {
        let n: i64 = st.conn.query_row("SELECT COUNT(*) FROM rules", [], |r| r.get(0)).map_err(e)?;
        if n >= MAX_RULES {
            return Err(tr!("规则最多 {MAX_RULES} 条", "You can have at most {MAX_RULES} rules"));
        }
        let sort: i64 = st.conn.query_row("SELECT IFNULL(MAX(sort), -1) + 1 FROM rules", [], |r| r.get(0)).map_err(e)?;
        st.conn
            .execute(
                "INSERT INTO rules(name, enabled, sort, account_id, match_all, conds_json, actions_json, stop, created) VALUES(?,?,?,?,?,?,?,?,?)",
                params![name, rule.enabled, sort, rule.account_id, rule.match_all, conds, actions, rule.stop, now()],
            )
            .map_err(e)?;
        Ok(st.conn.last_insert_rowid())
    } else {
        let n = st
            .conn
            .execute(
                "UPDATE rules SET name=?, enabled=?, account_id=?, match_all=?, conds_json=?, actions_json=?, stop=? WHERE id=?",
                params![name, rule.enabled, rule.account_id, rule.match_all, conds, actions, rule.stop, rule.id],
            )
            .map_err(e)?;
        if n == 0 {
            return Err(crate::i18n::t("这条规则已经不存在了", "This rule no longer exists").into());
        }
        Ok(rule.id)
    }
}

#[tauri::command]
pub async fn rule_delete(ctx: State<'_, Arc<Ctx>>, id: i64) -> Res<()> {
    let st = ctx.store.lock().unwrap();
    st.conn.execute("DELETE FROM rules WHERE id=?", [id]).map_err(e)?;
    Ok(())
}

#[tauri::command]
pub async fn rule_order(ctx: State<'_, Arc<Ctx>>, ids: Vec<i64>) -> Res<()> {
    let st = ctx.store.lock().unwrap();
    let tx = st.conn.unchecked_transaction().map_err(e)?;
    for (i, id) in ids.iter().enumerate() {
        st.conn.execute("UPDATE rules SET sort=? WHERE id=?", params![i as i64, id]).map_err(e)?;
    }
    tx.commit().map_err(e)?;
    Ok(())
}

/// 一封信合并后的结果：每项「已经有值就不再改」，排在前面的规则优先
#[derive(Default)]
struct Outcome {
    seen: Option<bool>,
    flagged: Option<bool>,
    /// archive / junk / move:<path>
    dest: Option<String>,
}

/// 对收件箱里这次新到的邮件跑规则：本地先改好（标记、移动占位），返回要交给同步任务的操作，
/// 以及「被移走或被标成已读」的邮件 id（调用方不为它们弹提醒）
pub fn run(ctx: &Ctx, account_id: i64, inbox_id: i64, inbox_path: &str, ids: &[i64]) -> (Vec<Op>, HashSet<i64>) {
    let st = ctx.store.lock().unwrap();
    let rules = match read_rules(
        &st,
        &format!("{SELECT_RULES} WHERE enabled=1 AND (account_id IS NULL OR account_id=?) ORDER BY sort, id"),
        &[&account_id],
    ) {
        Ok(r) => r.into_iter().filter(|r| r.enabled).collect::<Vec<_>>(),
        Err(err) => {
            crate::applog::warn(&format!("读取邮件规则失败：{err}"));
            return (vec![], HashSet::new());
        }
    };
    if rules.is_empty() || ids.is_empty() {
        return (vec![], HashSet::new());
    }
    let Ok(json) = serde_json::to_string(ids) else { return (vec![], HashSet::new()) };
    // (id, uid, 当前已读, 当前重点, 邮件)
    let msgs: Vec<(i64, u32, bool, bool, MsgView)> = {
        let q = st.conn.prepare(
            "SELECT id, uid, from_name, from_addr, to_json, subject, has_att, seen, flagged FROM messages
             WHERE id IN (SELECT value FROM json_each(?)) AND folder_id=? AND uid>0",
        );
        let mut q = match q {
            Ok(q) => q,
            Err(err) => {
                crate::applog::warn(&format!("读取新邮件失败（邮件规则）：{err}"));
                return (vec![], HashSet::new());
            }
        };
        let v = q
            .query_map(params![json, inbox_id], |r| {
                let to_json: String = r.get(4)?;
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, u32>(1)?,
                    r.get::<_, bool>(7)?,
                    r.get::<_, bool>(8)?,
                    MsgView {
                        from_name: r.get(2)?,
                        from_addr: r.get(3)?,
                        to: serde_json::from_str(&to_json).unwrap_or_default(),
                        subject: r.get(5)?,
                        has_att: r.get::<_, i64>(6)? != 0,
                    },
                ))
            })
            .map(|it| it.filter_map(|x| x.ok()).collect())
            .unwrap_or_default();
        v
    };

    // 每封信过一遍规则，合并动作
    let mut outcomes: Vec<(i64, u32, bool, bool, Outcome, i64)> = vec![]; // 最后一项：决定去向的规则 id
    for (id, uid, seen, flagged, m) in msgs {
        let mut o = Outcome::default();
        let mut dest_rule = 0;
        for r in &rules {
            if !matches(r, &m) {
                continue;
            }
            for a in &r.actions {
                match a.kind.as_str() {
                    "read" if o.seen.is_none() => o.seen = Some(true),
                    "unread" if o.seen.is_none() => o.seen = Some(false),
                    "flag" if o.flagged.is_none() => o.flagged = Some(true),
                    "unflag" if o.flagged.is_none() => o.flagged = Some(false),
                    "archive" | "junk" if o.dest.is_none() => {
                        o.dest = Some(a.kind.clone());
                        dest_rule = r.id;
                    }
                    "move" if o.dest.is_none() => {
                        o.dest = Some(format!("move:{}", a.folder));
                        dest_rule = r.id;
                    }
                    _ => {}
                }
            }
            if r.stop {
                break;
            }
        }
        if o.seen.is_some() || o.flagged.is_some() || o.dest.is_some() {
            outcomes.push((id, uid, seen, flagged, o, dest_rule));
        }
    }
    if outcomes.is_empty() {
        return (vec![], HashSet::new());
    }

    // 去向解析成 (文件夹 id, path)；同一批里同一去向只查一次
    let mut resolved: HashMap<String, Option<(i64, String)>> = HashMap::new();
    let mut resolve = |dest: &str| -> Option<(i64, String)> {
        if let Some(v) = resolved.get(dest) {
            return v.clone();
        }
        let by_role = |role: &str| -> Option<(i64, String)> {
            st.conn
                .query_row("SELECT id, path FROM folders WHERE account_id=? AND role=?", params![account_id, role], |r| Ok((r.get(0)?, r.get(1)?)))
                .ok()
        };
        let v = match dest {
            "archive" => by_role("archive").or_else(|| by_role("all")).or_else(|| {
                // 没有归档文件夹：本地先建，服务器上由 Op::Move 创建（和 move_to 一样）
                st.conn
                    .execute(
                        "INSERT INTO folders(account_id, path, name, role) VALUES(?, 'Archive', 'Archive', 'archive') ON CONFLICT(account_id, path) DO UPDATE SET role='archive'",
                        [account_id],
                    )
                    .ok()?;
                st.conn
                    .query_row("SELECT id FROM folders WHERE account_id=? AND path='Archive'", [account_id], |r| r.get::<_, i64>(0))
                    .ok()
                    .map(|fid| (fid, "Archive".to_string()))
            }),
            "junk" => by_role("junk"),
            d => d.strip_prefix("move:").and_then(|path| {
                st.conn
                    .query_row("SELECT id, path FROM folders WHERE account_id=? AND path=?", params![account_id, path], |r| Ok((r.get(0)?, r.get(1)?)))
                    .ok()
            }),
        };
        let v = v.filter(|(fid, _)| *fid != inbox_id);
        resolved.insert(dest.to_string(), v.clone());
        v
    };

    // (邮件 id, 原 uid, 目标文件夹 id, 目标 path)
    let mut moves: Vec<(i64, u32, i64, String)> = vec![];
    let mut seen_set: Vec<(i64, u32, bool)> = vec![];
    let mut flag_set: Vec<(i64, u32, bool)> = vec![];
    for (id, uid, seen, flagged, o, dest_rule) in &outcomes {
        if let Some(s) = o.seen {
            if s != *seen {
                seen_set.push((*id, *uid, s));
            }
        }
        if let Some(f) = o.flagged {
            if f != *flagged {
                flag_set.push((*id, *uid, f));
            }
        }
        if let Some(d) = &o.dest {
            match resolve(d) {
                Some((fid, path)) => moves.push((*id, *uid, fid, path)),
                None => crate::applog::warn(&format!("邮件规则 {dest_rule} 的目标文件夹找不到，没有移动（账号 {account_id}）")),
            }
        }
    }
    drop(resolve);

    let r = (|| -> rusqlite::Result<()> {
        let tx = st.conn.unchecked_transaction()?;
        for (id, _, s) in &seen_set {
            st.conn.execute("UPDATE messages SET seen=? WHERE id=?", params![s, id])?;
        }
        for (id, _, f) in &flag_set {
            st.conn.execute("UPDATE messages SET flagged=? WHERE id=?", params![f, id])?;
        }
        for (id, _, fid, _) in &moves {
            st.conn.execute(
                "UPDATE messages SET orig_folder=folder_id, orig_uid=uid, folder_id=?, uid=?, moving=0 WHERE id=?",
                params![fid, -id, id],
            )?;
        }
        if !seen_set.is_empty() || !flag_set.is_empty() {
            crate::FLAG_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        st.refresh_counts(account_id).map_err(|err| rusqlite::Error::ToSqlConversionFailure(err.into()))?;
        tx.commit()
    })();
    if let Err(err) = r {
        crate::applog::warn(&format!("邮件规则落库失败（账号 {account_id}）：{err}"));
        return (vec![], HashSet::new());
    }

    let mut ops = vec![];
    for (flag, list) in [("\\Seen", &seen_set), ("\\Flagged", &flag_set)] {
        for add in [true, false] {
            let uids: Vec<u32> = list.iter().filter(|x| x.2 == add).map(|x| x.1).collect();
            if !uids.is_empty() {
                ops.push(Op::Flags { path: inbox_path.to_string(), uids, flag, add });
            }
        }
    }
    let mut by_dest: BTreeMap<String, (Vec<u32>, Vec<i64>)> = BTreeMap::new();
    for (id, uid, _, path) in &moves {
        let e = by_dest.entry(path.clone()).or_default();
        e.0.push(*uid);
        e.1.push(*id);
    }
    for (to, (uids, ids)) in by_dest {
        ops.push(Op::Move { from: inbox_path.to_string(), uids, to, ids });
    }

    let mut quiet: HashSet<i64> = moves.iter().map(|x| x.0).collect();
    quiet.extend(seen_set.iter().filter(|x| x.2).map(|x| x.0));
    crate::applog::info(&format!("邮件规则处理了 {} 封新邮件", outcomes.len()));
    (ops, quiet)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg() -> MsgView {
        MsgView {
            from_name: "GitHub".into(),
            from_addr: "Notifications@GitHub.com".into(),
            to: vec![Addr { name: "Me".into(), email: "me@example.com".into() }, Addr { name: "".into(), email: "alias@example.com".into() }],
            subject: "Build Succeeded".into(),
            has_att: false,
        }
    }

    fn rule(match_all: bool, conds: Vec<(&str, &str, &str)>) -> Rule {
        Rule {
            id: 1,
            name: String::new(),
            enabled: true,
            account_id: None,
            match_all,
            conds: conds.into_iter().map(|(f, o, v)| Cond { field: f.into(), op: o.into(), value: v.into() }).collect(),
            actions: vec![Action { kind: "read".into(), folder: String::new() }],
            stop: false,
        }
    }

    #[test]
    fn all_and_any() {
        let m = msg();
        assert!(matches(&rule(true, vec![("from", "contains", "github"), ("subject", "contains", "succeeded")]), &m));
        assert!(!matches(&rule(true, vec![("from", "contains", "github"), ("subject", "contains", "failed")]), &m));
        assert!(matches(&rule(false, vec![("from", "contains", "nobody"), ("subject", "contains", "succeeded")]), &m));
        assert!(!matches(&rule(false, vec![("from", "contains", "nobody"), ("subject", "contains", "failed")]), &m));
    }

    #[test]
    fn ops_and_case() {
        let m = msg();
        assert!(matches(&rule(true, vec![("from", "equals", "notifications@github.com")]), &m));
        assert!(!matches(&rule(true, vec![("from", "equals", "github")]), &m));
        assert!(matches(&rule(true, vec![("from", "not_contains", "gitlab")]), &m));
        assert!(matches(&rule(true, vec![("subject", "equals", "build succeeded")]), &m));
        assert!(matches(&rule(true, vec![("SUBJECT".to_lowercase().as_str(), "contains", "BUILD")]), &m));
        assert!(matches(&rule(true, vec![("to", "equals", "ALIAS@example.com")]), &m));
        assert!(matches(&rule(true, vec![("to", "contains", "me")]), &m));
        assert!(!matches(&rule(true, vec![("to", "not_contains", "alias")]), &m));
        assert!(matches(&rule(true, vec![("to", "not_contains", "other")]), &m));
    }

    #[test]
    fn empty_conds_never_match() {
        assert!(!matches(&rule(true, vec![]), &msg()));
        assert!(!matches(&rule(false, vec![]), &msg()));
    }

    #[test]
    fn attachment() {
        let mut m = msg();
        assert!(matches(&rule(true, vec![("attachment", "none", "")]), &m));
        assert!(!matches(&rule(true, vec![("attachment", "has", "")]), &m));
        m.has_att = true;
        assert!(matches(&rule(true, vec![("attachment", "has", "")]), &m));
    }
}

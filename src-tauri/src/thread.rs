//! 会话归并：按 Message-ID / In-Reply-To / References 把同一来回的邮件归成一串（同一账号内，不跨账号，不按标题合并）。
//! thread_keys 记着「见过的每个 Message-ID 属于哪一串」，所以回复先到、原信后到，或中间缺几封，也能对上。
//! 数据库升级步骤 v3 也调这里给旧邮件补会话编号：发版之后归并规则别改出不兼容的结果。

use rusqlite::{params, Connection, OptionalExtension};
use std::collections::BTreeSet;

const MAX_KEYS: usize = 60;

fn strip(t: &str) -> &str {
    t.trim().trim_matches(|c| c == '<' || c == '>' || c == ',')
}

/// 这封邮件带的所有 Message-ID：自己的放第一个，后面是它引用的（去掉尖括号，去重）
fn keys(msgid: &str, in_reply_to: &str, refs: &str) -> Vec<String> {
    let mut v: Vec<String> = vec![];
    let own = strip(msgid);
    if !own.is_empty() && own.len() <= 300 {
        v.push(own.to_string());
    }
    for tok in refs.split_whitespace().chain(in_reply_to.split_whitespace()) {
        let t = strip(tok);
        // In-Reply-To 里偶尔有说明文字，不含 @ 的不算 Message-ID
        if t.contains('@') && t.len() <= 300 && !v.iter().any(|x| x == t) {
            v.push(t.to_string());
        }
    }
    if v.len() > MAX_KEYS {
        // 引用太多：留自己的和最近的那些
        let tail = v.split_off(v.len() - (MAX_KEYS - 1));
        v.truncate(1);
        v.extend(tail);
    }
    v
}

/// 给一封邮件定会话编号并写进 messages.thread_id，返回编号。
/// 引用到两串不同的会话时把它们并成一串（编号取小的）。没有 Message-ID 也没有引用的邮件自己一串。
pub fn assign(conn: &Connection, account_id: i64, msg_id: i64, msgid: &str, in_reply_to: &str, refs: &str) -> rusqlite::Result<i64> {
    let ks = keys(msgid, in_reply_to, refs);
    let mut found: BTreeSet<i64> = BTreeSet::new();
    {
        let mut q = conn.prepare_cached("SELECT thread_id FROM thread_keys WHERE account_id=? AND key=?")?;
        for k in &ks {
            if let Some(t) = q.query_row(params![account_id, k], |r| r.get::<_, i64>(0)).optional()? {
                found.insert(t);
            }
        }
    }
    let tid = match found.iter().next() {
        Some(t) => *t,
        None => {
            // 新会话单独发号，不用邮件 id：邮件删掉后 id 会被新邮件复用，不相干的信会被并进旧会话
            conn.execute("INSERT INTO thread_seq DEFAULT VALUES", [])?;
            let t = conn.last_insert_rowid();
            conn.execute("DELETE FROM thread_seq WHERE id < ?", [t])?;
            t
        }
    };
    for other in found.iter().skip(1) {
        conn.execute("UPDATE messages SET thread_id=?1 WHERE account_id=?2 AND thread_id=?3", params![tid, account_id, other])?;
        conn.execute("UPDATE thread_keys SET thread_id=?1 WHERE account_id=?2 AND thread_id=?3", params![tid, account_id, other])?;
    }
    conn.execute("UPDATE messages SET thread_id=? WHERE id=?", params![tid, msg_id])?;
    {
        let mut ins = conn.prepare_cached(
            "INSERT INTO thread_keys(account_id, key, thread_id) VALUES(?,?,?) ON CONFLICT(account_id, key) DO UPDATE SET thread_id=excluded.thread_id",
        )?;
        for k in &ks {
            ins.execute(params![account_id, k, tid])?;
        }
    }
    Ok(tid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, thread_id INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE thread_keys (account_id INTEGER NOT NULL, key TEXT NOT NULL, thread_id INTEGER NOT NULL, PRIMARY KEY (account_id, key)) WITHOUT ROWID;
             CREATE INDEX idx_tkeys_thread ON thread_keys(account_id, thread_id);
             CREATE TABLE thread_seq (id INTEGER PRIMARY KEY AUTOINCREMENT);",
        )
        .unwrap();
        c
    }

    fn add(c: &Connection, acc: i64, msgid: &str, irt: &str, refs: &str) -> i64 {
        c.execute("INSERT INTO messages(account_id) VALUES(?)", [acc]).unwrap();
        let id = c.last_insert_rowid();
        assign(c, acc, id, msgid, irt, refs).unwrap();
        id
    }

    fn tid(c: &Connection, id: i64) -> i64 {
        c.query_row("SELECT thread_id FROM messages WHERE id=?", [id], |r| r.get(0)).unwrap()
    }

    #[test]
    fn reply_chain_is_one_thread() {
        let c = db();
        let a = add(&c, 1, "<a@x>", "", "");
        // In-Reply-To 只有一个值时存的是不带尖括号的
        let b = add(&c, 1, "<b@x>", "a@x", "a@x");
        let d = add(&c, 1, "<c@x>", "b@x", "<a@x> <b@x>");
        assert!(tid(&c, a) != 0);
        assert_eq!(tid(&c, a), tid(&c, b));
        assert_eq!(tid(&c, a), tid(&c, d));
    }

    #[test]
    fn out_of_order_and_missing_middle() {
        let c = db();
        // 回复先到，原信后到；中间那封 b 一直没收到
        let d = add(&c, 1, "<c@x>", "<b@x>", "<a@x> <b@x>");
        let a = add(&c, 1, "<a@x>", "", "");
        assert_eq!(tid(&c, a), tid(&c, d));
    }

    #[test]
    fn merges_two_threads() {
        let c = db();
        let a = add(&c, 1, "<a@x>", "", "");
        let b = add(&c, 1, "<b@x>", "", "");
        assert!(tid(&c, a) != tid(&c, b));
        let m = add(&c, 1, "<m@x>", "<b@x>", "<a@x> <b@x>");
        assert_eq!(tid(&c, a), tid(&c, b));
        assert_eq!(tid(&c, a), tid(&c, m));
        // 并完之后再来的回复也进同一串
        let r = add(&c, 1, "<r@x>", "<b@x>", "");
        assert_eq!(tid(&c, r), tid(&c, a));
    }

    #[test]
    fn no_headers_never_merge() {
        let c = db();
        let a = add(&c, 1, "", "", "");
        let b = add(&c, 1, "", "", "");
        assert!(tid(&c, a) != 0 && tid(&c, b) != 0);
        assert!(tid(&c, a) != tid(&c, b));
    }

    #[test]
    fn accounts_stay_apart() {
        let c = db();
        let a = add(&c, 1, "<a@x>", "", "");
        let b = add(&c, 2, "<a@x>", "", "");
        let r = add(&c, 2, "<r@x>", "<a@x>", "");
        assert!(tid(&c, a) != tid(&c, b));
        assert_eq!(tid(&c, b), tid(&c, r));
    }

    #[test]
    fn deleted_newest_message_id_reuse_does_not_merge() {
        let c = db();
        let a = add(&c, 1, "<a@x>", "", "");
        let ta = tid(&c, a);
        c.execute("DELETE FROM messages WHERE id=?", [a]).unwrap();
        // 新邮件复用了同一个 id，但和旧会话无关
        let n = add(&c, 1, "<n@x>", "", "");
        assert_eq!(n, a);
        assert!(tid(&c, n) != ta);
    }

    #[test]
    fn too_many_refs_keep_own_and_latest() {
        let refs: String = (0..200).map(|i| format!("<r{i}@x>")).collect::<Vec<_>>().join(" ");
        let k = keys("<own@x>", "", &refs);
        assert_eq!(k.len(), MAX_KEYS);
        assert_eq!(k[0], "own@x");
        assert_eq!(k.last().unwrap(), "r199@x");
    }
}

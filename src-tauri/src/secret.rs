//! 密码、授权码、AI 密钥只存在系统凭据库里（Windows 凭据管理器 / Mac 钥匙串，系统加密），数据库里不放。

use anyhow::{anyhow, Result};
use std::sync::Mutex;

/// AI 密钥缓存（界面每次刷新都要问「配好了没有」，别每次都去读凭据管理器）
static AI_CACHE: Mutex<Option<Option<String>>> = Mutex::new(None);

fn service() -> String {
    // 测试实例用单独的凭据命名空间
    match std::env::var("KOJOOMAIL_DATA") {
        Ok(v) if !v.is_empty() => "KojooMail-test".into(),
        _ => "KojooMail".into(),
    }
}

fn entry(key: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(&service(), key).map_err(|e| anyhow!(tr!("凭据管理器不可用：{e}", "The credential store isn't available: {e}")))
}

// ───── 直接读写系统凭据库（一把钥匙一条） ─────

fn raw_read(key: &str) -> Result<Option<String>, String> {
    match entry(key).map_err(|e| e.to_string())?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn raw_set(key: &str, value: &str) -> Result<(), String> {
    entry(key).map_err(|e| e.to_string())?.set_password(value).map_err(|e| e.to_string())
}

fn raw_delete(key: &str) {
    if let Ok(e) = entry(key) {
        let _ = e.delete_credential();
    }
}

// ───── Mac：全部凭据合成钥匙串里的一条，读一次后记在内存里 ─────
//
// 没有苹果开发者账号，程序每次更新后钥匙串都可能把它当成新程序、重新弹窗问一遍，一条凭据问一次。
// 以前每个账号一条、每次重连都去读：三个账号更新后要点三次；半夜断线重连时弹的窗没人看到，
// 账号就一直连不上（2026-11-17 王嘉）。现在：
//   - 所有凭据放进一条（VAULT_KEY，内容是 JSON 对象），更新后最多问一次；
//   - 读到以后记在内存里，这次运行不再碰钥匙串，弹窗只会出现在刚打开程序的时候；
//   - 老版本留下的单条凭据第一次用到时搬进来（那一次还是一条问一次）。老的那条不删也不再更新
//     （去动它又会引出弹窗）：装回旧版时，之后没改过的密码还能用，改过的要重新填。
//   - 值为空串 = 已删除（不再回头去读老的那条）。
// Windows 的凭据管理器不弹窗，照旧一把钥匙一条（USE_VAULT 为假）。

const VAULT_KEY: &str = "vault";
const USE_VAULT: bool = cfg!(target_os = "macos");

trait Backend {
    fn read(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
}

struct Keychain;

impl Backend for Keychain {
    fn read(&self, key: &str) -> Result<Option<String>, String> {
        raw_read(key)
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        raw_set(key, value)
    }
}

#[derive(Default)]
struct Vault {
    /// 读到以后才有；None = 还没读到
    map: Option<std::collections::HashMap<String, String>>,
    /// 老的单条凭据里确认没有的钥匙（这次运行不再去查）
    no_legacy: std::collections::HashSet<String>,
    /// 钥匙串里哪一条上次没读到、什么时候、什么原因。读到了就清掉
    failed: std::collections::HashMap<String, (std::time::Instant, String)>,
    /// 删了但还没写进钥匙串的（当时读不到 / 写不进）：这次运行里一律当没有，读到 / 能写了再补上
    dropped: std::collections::HashSet<String>,
}

/// 刚失败过的这几秒内不再去读：几个账号同时来读时，别一人弹一次窗
const FAIL_MEMO: std::time::Duration = std::time::Duration::from_secs(5);
/// 合并的那一条内容坏了时，原样另存一份到这里再重建（别直接盖掉）
const VAULT_BAD_KEY: &str = "vault-bad";

impl Vault {
    /// 读钥匙串里的一条。passive：只要上次没读到就不再去读（界面上顺带问一句「AI 配了没有」不该引出系统弹窗，
    /// 重读由账号连接的定时重试和用户点「重试」来带）
    fn item(&mut self, b: &dyn Backend, item: &str, passive: bool) -> Result<Option<String>, String> {
        if let Some((t, e)) = self.failed.get(item) {
            if passive || t.elapsed() < FAIL_MEMO {
                return Err(e.clone());
            }
        }
        match b.read(item) {
            Ok(v) => {
                self.failed.remove(item);
                Ok(v)
            }
            Err(e) => {
                if !self.failed.contains_key(item) {
                    crate::applog::warn(&format!("读不到系统里保存的凭据 {item}：{e}"));
                }
                self.failed.insert(item.to_string(), (std::time::Instant::now(), e.clone()));
                Err(e)
            }
        }
    }

    fn load(&mut self, b: &dyn Backend, passive: bool) -> Result<(), String> {
        if self.map.is_some() {
            return Ok(());
        }
        let raw = self.item(b, VAULT_KEY, passive)?;
        let map = match raw {
            None => Default::default(),
            Some(s) => match serde_json::from_str(&s) {
                Ok(m) => m,
                Err(e) => {
                    // 内容坏了：原样另存一份，当成空的重建（老的单条凭据还在，会重新搬进来）
                    crate::applog::warn(&format!("钥匙串里合并的那条凭据解析不了（{e}），已另存一份并重建"));
                    let _ = b.set(VAULT_BAD_KEY, &s);
                    Default::default()
                }
            },
        };
        self.map = Some(map);
        if !self.dropped.is_empty() {
            let m = self.map.as_mut().unwrap();
            for k in &self.dropped {
                m.insert(k.clone(), String::new());
            }
            if self.save(b).is_ok() {
                self.dropped.clear();
            }
        }
        Ok(())
    }

    fn save(&self, b: &dyn Backend) -> Result<(), String> {
        let s = serde_json::to_string(self.map.as_ref().expect("loaded")).map_err(|e| e.to_string())?;
        b.set(VAULT_KEY, &s)
    }

    fn read(&mut self, b: &dyn Backend, key: &str, passive: bool) -> Result<Option<String>, String> {
        if self.dropped.contains(key) {
            return Ok(None);
        }
        self.load(b, passive)?;
        if let Some(v) = self.map.as_ref().unwrap().get(key) {
            return Ok(Some(v.clone()).filter(|v| !v.is_empty()));
        }
        if self.no_legacy.contains(key) {
            return Ok(None);
        }
        match self.item(b, key, passive)? {
            None => {
                self.no_legacy.insert(key.to_string());
                Ok(None)
            }
            Some(v) => {
                // 搬进来。这次没存上也不要紧：值已经在内存里，下次启动再搬一遍
                self.map.as_mut().unwrap().insert(key.to_string(), v.clone());
                let _ = self.save(b);
                Ok(Some(v))
            }
        }
    }

    /// 写入。没存上就把内存里的改回去，和钥匙串里保持一致
    fn put(&mut self, b: &dyn Backend, key: &str, value: &str) -> Result<(), String> {
        self.load(b, false)?;
        let old = self.map.as_mut().unwrap().insert(key.to_string(), value.to_string());
        if old.as_deref() != Some(value) {
            if let Err(e) = self.save(b) {
                let m = self.map.as_mut().unwrap();
                match old {
                    Some(o) => m.insert(key.to_string(), o),
                    None => m.remove(key),
                };
                return Err(e);
            }
        }
        self.dropped.remove(key);
        Ok(())
    }

    /// 删除：留一个空值占位（老的那条万一没删掉，也不会再被搬回来）。
    /// 钥匙串这会儿读不到 / 写不进也算数：这次运行里它就是没有了，等能写了再补上
    fn remove(&mut self, b: &dyn Backend, key: &str) {
        self.dropped.insert(key.to_string());
        if self.load(b, false).is_err() {
            return;
        }
        self.map.as_mut().unwrap().insert(key.to_string(), String::new());
        if self.save(b).is_ok() {
            self.dropped.clear();
        }
    }
}

static VAULT: Mutex<Option<Vault>> = Mutex::new(None);

fn with_vault<T>(f: impl FnOnce(&mut Vault) -> T) -> T {
    f(VAULT.lock().unwrap().get_or_insert_with(Vault::default))
}

// ───── 对外 ─────

pub fn set(key: &str, value: &str) -> Result<()> {
    if key == AI_KEY {
        *AI_CACHE.lock().unwrap() = None;
    }
    let r = if USE_VAULT { with_vault(|v| v.put(&Keychain, key, value)) } else { raw_set(key, value) };
    r.map_err(|e| anyhow!(tr!("保存密码失败：{e}", "Couldn't save the password: {e}")))
}

/// 读凭据，读不到和没有都算没有。要判断「账号的密码在不在」别用它，用 `read`
pub fn get(key: &str) -> Option<String> {
    if key == AI_KEY {
        let mut c = AI_CACHE.lock().unwrap();
        if let Some(v) = c.as_ref() {
            return v.clone();
        }
        // 界面每次刷新都会问到这里：上次没读到就不再去碰钥匙串（不引出系统弹窗），也不把「没读到」记成「没有」
        let r = if USE_VAULT { with_vault(|v| v.read(&Keychain, key, true)) } else { raw_read(key) };
        let v = r.ok()?.map(|s| unwrap_ai_key(&s));
        *c = Some(v.clone());
        return v;
    }
    read(key).ok().flatten()
}

/// 读凭据，分清「确实没有」（Ok(None)）和「这次没读到」（Err）。
/// Mac 上读钥匙串可能要用户在弹窗里点允许（更新后、或上次只点了「允许」没点「始终允许」），
/// 弹窗没处理、锁屏时读会失败——那不是密码没了，过一会儿再读就有；
/// 当成「没有密码」会把好好的账号报成授权失效，而且不会自己恢复（2026-11-17）。
/// 可能卡在弹窗上等用户：异步代码里放进 `spawn_blocking`
pub fn read(key: &str) -> Result<Option<String>, String> {
    if USE_VAULT { with_vault(|v| v.read(&Keychain, key, false)) } else { raw_read(key) }
}

/// 用户点了「重试」：忘掉刚才的失败，下一次读直接去问钥匙串
pub fn retry_now() {
    if USE_VAULT {
        with_vault(|v| v.failed.clear());
    }
}

pub fn delete(key: &str) {
    if key == AI_KEY {
        *AI_CACHE.lock().unwrap() = None;
    }
    if USE_VAULT {
        with_vault(|v| v.remove(&Keychain, key));
    }
    raw_delete(key);
}

/// 凭据版本号：用户改了密码、重新登录时加一。worker 靠它判断「要不要立刻重新登录」，
/// 不能看凭据本身变没变——一键登录的长期授权每次换令牌都会变（微软），那样授权失效时每次操作都会重登
static GEN: Mutex<Option<std::collections::HashMap<i64, u64>>> = Mutex::new(None);

pub fn cred_gen(account_id: i64) -> u64 {
    GEN.lock().unwrap().as_ref().and_then(|m| m.get(&account_id).copied()).unwrap_or(0)
}

pub fn bump_cred(account_id: i64) {
    *GEN.lock().unwrap().get_or_insert_with(Default::default).entry(account_id).or_insert(0) += 1;
}

pub fn account_key(account_id: i64) -> String {
    format!("account-{account_id}")
}

pub const AI_KEY: &str = "ai-api-key";

/// 密钥框里粘贴的是整段配置（New API / One API 后台「复制配置」给的 {"_type":…,"key":"sk-…","url":…} 这类）时，取出里面的密钥。
/// 普通密钥原样返回。2026-11-16：整段当密钥发出去，网关回 401 Invalid token
pub fn unwrap_ai_key(s: &str) -> String {
    let t = s.trim();
    if t.starts_with('{') {
        if let Ok(serde_json::Value::Object(m)) = serde_json::from_str::<serde_json::Value>(t) {
            for k in ["key", "api_key", "apiKey", "apikey", "token", "access_token"] {
                if let Some(serde_json::Value::String(v)) = m.get(k) {
                    if !v.trim().is_empty() {
                        return v.trim().to_string();
                    }
                }
            }
        }
    }
    t.to_string()
}

#[cfg(test)]
mod tests {
    use super::{Backend, Vault, VAULT_KEY};
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    /// 假钥匙串：记下读了几次；locked 为真时一律读不到（相当于弹窗没人点）
    #[derive(Default)]
    struct Fake {
        items: RefCell<HashMap<String, String>>,
        reads: Cell<u32>,
        locked: Cell<bool>,
        readonly: Cell<bool>,
    }

    impl Backend for Fake {
        fn read(&self, key: &str) -> Result<Option<String>, String> {
            self.reads.set(self.reads.get() + 1);
            if self.locked.get() {
                return Err("user interaction is not allowed".into());
            }
            Ok(self.items.borrow().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            if self.locked.get() || self.readonly.get() {
                return Err("denied".into());
            }
            self.items.borrow_mut().insert(key.into(), value.into());
            Ok(())
        }
    }

    fn fake(items: &[(&str, &str)]) -> Fake {
        let f = Fake::default();
        for (k, v) in items {
            f.items.borrow_mut().insert(k.to_string(), v.to_string());
        }
        f
    }

    #[test]
    fn vault_moves_old_items_in_and_reads_keychain_once() {
        let f = fake(&[("account-1", "pw1"), ("account-2", "pw2")]);
        let mut v = Vault::default();
        assert_eq!(v.read(&f, "account-1", false).unwrap().as_deref(), Some("pw1"));
        assert_eq!(v.read(&f, "account-2", false).unwrap().as_deref(), Some("pw2"));
        assert_eq!(v.read(&f, "account-9", false).unwrap(), None);
        let n = f.reads.get();
        // 之后再读多少次都不碰钥匙串（断线重连不会再弹窗）
        for _ in 0..5 {
            assert_eq!(v.read(&f, "account-1", false).unwrap().as_deref(), Some("pw1"));
            assert_eq!(v.read(&f, "account-9", false).unwrap(), None);
        }
        assert_eq!(f.reads.get(), n);
        // 老的那条留着（装回旧版还能用），合并的那条里两个都有
        assert_eq!(f.items.borrow().get("account-1").map(String::as_str), Some("pw1"));
        let all: HashMap<String, String> = serde_json::from_str(f.items.borrow().get(VAULT_KEY).unwrap()).unwrap();
        assert_eq!(all.len(), 2);
        // 下次启动：只读合并的那一条
        let mut v2 = Vault::default();
        let before = f.reads.get();
        assert_eq!(v2.read(&f, "account-1", false).unwrap().as_deref(), Some("pw1"));
        assert_eq!(v2.read(&f, "account-2", false).unwrap().as_deref(), Some("pw2"));
        assert_eq!(f.reads.get(), before + 1);
    }

    /// 拿真的系统凭据库走一遍（Mac 上就是钥匙串）。只在测试命名空间里写，跑完删掉：
    /// `KOJOOMAIL_DATA=x cargo test --lib real_keychain -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_keychain() {
        assert_eq!(super::service(), "KojooMail-test", "要带 KOJOOMAIL_DATA 跑，别碰正式凭据");
        let k = super::Keychain;
        for key in [VAULT_KEY, "selftest-1", "selftest-2"] {
            super::raw_delete(key);
        }
        // 老版本留下的两条
        super::raw_set("selftest-1", "pw-1").unwrap();
        super::raw_set("selftest-2", "长一点的 refresh token / 带中文和符号 {\"a\":1}").unwrap();
        let mut v = Vault::default();
        assert_eq!(v.read(&k, "selftest-1", false).unwrap().as_deref(), Some("pw-1"));
        assert!(v.read(&k, "selftest-2", false).unwrap().unwrap().contains("中文"));
        assert_eq!(v.read(&k, "selftest-none", false).unwrap(), None);
        v.put(&k, "selftest-3", "pw-3").unwrap();
        v.remove(&k, "selftest-1");
        // 重新打开：只靠合并的那一条
        super::raw_delete("selftest-2");
        let mut v2 = Vault::default();
        assert_eq!(v2.read(&k, "selftest-1", false).unwrap(), None);
        assert!(v2.read(&k, "selftest-2", false).unwrap().unwrap().contains("中文"));
        assert_eq!(v2.read(&k, "selftest-3", false).unwrap().as_deref(), Some("pw-3"));
        let raw = super::raw_read(VAULT_KEY).unwrap().unwrap();
        println!("合并的那一条：{} 字节", raw.len());
        for key in [VAULT_KEY, "selftest-1", "selftest-2"] {
            super::raw_delete(key);
        }
        assert_eq!(super::raw_read(VAULT_KEY).unwrap(), None);
    }

    #[test]
    fn vault_unreadable_is_an_error_not_a_missing_password() {
        let f = fake(&[("account-1", "pw1")]);
        f.locked.set(true);
        let mut v = Vault::default();
        assert!(v.read(&f, "account-1", false).is_err());
        // 几个账号紧接着来读：不再各弹一次窗
        assert!(v.read(&f, "account-2", false).is_err());
        assert_eq!(f.reads.get(), 1);
        assert!(v.put(&f, "account-3", "x").is_err());
        // 用户点了允许以后恢复
        f.locked.set(false);
        v.failed.clear();
        assert_eq!(v.read(&f, "account-1", false).unwrap().as_deref(), Some("pw1"));
    }

    #[test]
    fn vault_old_item_unreadable_is_an_error_too() {
        // 合并的那条读到了（空的），老的单条读不到：是「这次没读到」，不是没有
        struct OldLocked(Fake);
        impl Backend for OldLocked {
            fn read(&self, key: &str) -> Result<Option<String>, String> {
                if key == VAULT_KEY { self.0.read(key) } else { Err("denied".into()) }
            }
            fn set(&self, k: &str, v: &str) -> Result<(), String> {
                self.0.set(k, v)
            }
        }
        let f = OldLocked(fake(&[("account-1", "pw1")]));
        let mut v = Vault::default();
        assert!(v.read(&f, "account-1", false).is_err());
        assert!(v.read(&f, "account-1", false).is_err());
    }

    #[test]
    fn vault_set_delete_and_failed_save() {
        let f = fake(&[("ai-api-key", "old")]);
        let mut v = Vault::default();
        v.put(&f, "account-1", "pw").unwrap();
        assert_eq!(v.read(&f, "account-1", false).unwrap().as_deref(), Some("pw"));
        // 删除后不会从老的那条里又搬回来
        v.remove(&f, "ai-api-key");
        assert_eq!(v.read(&f, "ai-api-key", false).unwrap(), None);
        assert_eq!(Vault::default().read(&f, "ai-api-key", false).unwrap(), None);
        // 没存上：内存里改回去，报错
        f.readonly.set(true);
        assert!(v.put(&f, "account-1", "new").is_err());
        assert_eq!(v.read(&f, "account-1", false).unwrap().as_deref(), Some("pw"));
        assert!(v.put(&f, "account-2", "x").is_err());
        assert_eq!(v.read(&f, "account-2", false).unwrap(), None);
        // 合并的那条内容坏了：当成空的，从老的单条重新搬
        let g = fake(&[(VAULT_KEY, "not json"), ("account-1", "pw1")]);
        assert_eq!(Vault::default().read(&g, "account-1", false).unwrap().as_deref(), Some("pw1"));
        assert_eq!(g.items.borrow().get(super::VAULT_BAD_KEY).map(String::as_str), Some("not json"));
    }

    #[test]
    fn vault_passive_read_never_asks_again_and_delete_sticks() {
        let f = fake(&[(VAULT_KEY, r#"{"ai-api-key":"sk-1","account-1":"pw"}"#)]);
        f.locked.set(true);
        let mut v = Vault::default();
        // 界面顺带问的（AI 密钥）：第一次去读，没读到之后不再碰钥匙串
        assert!(v.read(&f, "ai-api-key", true).is_err());
        v.failed.get_mut(VAULT_KEY).unwrap().0 -= std::time::Duration::from_secs(60);
        assert!(v.read(&f, "ai-api-key", true).is_err());
        assert_eq!(f.reads.get(), 1);
        // 钥匙串读不到的时候删：这次运行里就是没有了
        v.remove(&f, "ai-api-key");
        assert_eq!(f.reads.get(), 2);
        assert_eq!(v.read(&f, "ai-api-key", true).unwrap(), None);
        // 账号连接的定时重试读到了：删除补写进去，别的照常
        f.locked.set(false);
        v.failed.clear();
        assert_eq!(v.read(&f, "account-1", false).unwrap().as_deref(), Some("pw"));
        assert_eq!(v.read(&f, "ai-api-key", false).unwrap(), None);
        assert_eq!(Vault::default().read(&f, "ai-api-key", false).unwrap(), None);
        assert_eq!(Vault::default().read(&f, "account-1", false).unwrap().as_deref(), Some("pw"));
    }

    #[test]
    fn unwrap_pasted_config() {
        assert_eq!(super::unwrap_ai_key(r#"{"_type":"newapi_channel_conn","key":"sk-abc","url":"https://x.example"}"#), "sk-abc");
        assert_eq!(super::unwrap_ai_key("  sk-plain  "), "sk-plain");
        assert_eq!(super::unwrap_ai_key("{not json"), "{not json");
        assert_eq!(super::unwrap_ai_key(r#"{"url":"https://x"}"#), r#"{"url":"https://x"}"#);
    }
}

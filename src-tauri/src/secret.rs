//! 密码、授权码、AI 密钥只存在 Windows 凭据管理器里（系统加密），数据库里不放。

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

pub fn set(key: &str, value: &str) -> Result<()> {
    if key == AI_KEY {
        *AI_CACHE.lock().unwrap() = None;
    }
    entry(key)?.set_password(value).map_err(|e| anyhow!(tr!("保存密码失败：{e}", "Couldn't save the password: {e}")))
}

pub fn get(key: &str) -> Option<String> {
    if key == AI_KEY {
        let mut c = AI_CACHE.lock().unwrap();
        if let Some(v) = c.as_ref() {
            return v.clone();
        }
        let v = entry(key).ok().and_then(|e| e.get_password().ok()).map(|s| unwrap_ai_key(&s));
        *c = Some(v.clone());
        return v;
    }
    entry(key).ok()?.get_password().ok()
}

pub fn delete(key: &str) {
    if key == AI_KEY {
        *AI_CACHE.lock().unwrap() = None;
    }
    if let Ok(e) = entry(key) {
        let _ = e.delete_credential();
    }
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
    #[test]
    fn unwrap_pasted_config() {
        assert_eq!(super::unwrap_ai_key(r#"{"_type":"newapi_channel_conn","key":"sk-abc","url":"https://x.example"}"#), "sk-abc");
        assert_eq!(super::unwrap_ai_key("  sk-plain  "), "sk-plain");
        assert_eq!(super::unwrap_ai_key("{not json"), "{not json");
        assert_eq!(super::unwrap_ai_key(r#"{"url":"https://x"}"#), r#"{"url":"https://x"}"#);
    }
}

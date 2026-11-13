import { useEffect, useMemo, useRef, useState } from 'react'
import { ask } from '../lib/ask'
import DOMPurify from 'dompurify'
import { Icon } from '../icons'
import { curRow, useApp } from '../store'
import { api, errText, type MsgFull, type MsgLite } from '../lib/api'
import { addrText, fullTime, shortTime, size } from '../lib/format'
import { Avatar, Empty, Kojoo, Loader, TipText, useMenu } from '../ui'
import { laterOptions, mailMenu } from './MailList'
import { IS_MAC } from '../lib/platform'
import { L, EN, catLabel } from '../lib/i18n'

export default function Reader() {
  const s = useApp()
  const m = s.open
  const menu = useMenu()
  const idx = curRow(s)
  // 按会话显示：这一串里当前这封之前、之后的邮件（只有一封时都是空的）
  const at = m ? s.thread.findIndex((x) => x.id === m.id) : -1
  const before = at >= 0 ? s.thread.slice(0, at) : []
  const after = at >= 0 ? s.thread.slice(at + 1) : []
  const inChain = at >= 0
  const activeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (inChain) activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [m?.id, inChain])

  if (!s.selected) {
    return (
      <section className="reader">
        <Empty icon="mail" title={s.items.length ? L('选一封邮件阅读', 'Select an email to read') : ' '} sub={s.items.length ? (EN ? <>Use <span className="kbd">J</span> <span className="kbd">K</span> to move, <span className="kbd">E</span> to archive</> : <>用 <span className="kbd">J</span> <span className="kbd">K</span> 上下切换，<span className="kbd">E</span> 归档</>) : undefined} />
      </section>
    )
  }
  if (!m) {
    return (
      <section className="reader">
        {s.openError ? (
          <Empty icon="alert" title={L('打不开这封邮件', "Couldn't open this email")} sub={s.openError}><button className="btn sm" onClick={() => s.select(s.selected)}>{L('重试', 'Retry')}</button></Empty>
        ) : <Loader text={L('正在下载邮件…', 'Downloading email…')} />}
      </section>
    )
  }

  const acc = s.accounts.find((a) => a.id === m.accountId)
  const compose = (mode: 'reply' | 'replyAll' | 'forward') => s.openCompose(mode, m)
  const nav = (d: number) => { const n = s.items[idx + d]; if (n) s.select(n.id) }

  return (
    <section className="reader" aria-label={L('阅读', 'Reading pane')}>
      <div className="reader-bar">
        <button className="tb" aria-label={L('回复', 'Reply')} data-tip={L('回复  R', 'Reply  R')} onClick={() => compose('reply')}><Icon name="reply" /></button>
        <button className="tb" aria-label={L('全部回复', 'Reply all')} data-tip={L('全部回复  A', 'Reply all  A')} onClick={() => compose('replyAll')}><Icon name="replyAll" /></button>
        <button className="tb" aria-label={L('转发', 'Forward')} data-tip={L('转发  F', 'Forward  F')} onClick={() => compose('forward')}><Icon name="forward" /></button>
        <span className="sep" />
        {m.role !== 'archive' && m.role !== 'all' && <button className="tb" aria-label={L('归档', 'Archive')} data-tip={L('归档  E', 'Archive  E')} onClick={() => s.move([m.id], 'archive', L('归档', 'archived'))}><Icon name="archive" /></button>}
        <button className={`tb${m.flagged ? ' on' : ''}`} aria-label={m.flagged ? L('取消重点', 'Remove from Important') : L('标为重点', 'Mark as important')} data-tip={m.flagged ? L('取消重点  S', 'Remove from Important  S') : L('标为重点  S', 'Mark as important  S')} onClick={() => s.mark([m.id], { flagged: !m.flagged })}><Icon name="flag" /></button>
        <button className="tb" aria-label={L('稍后处理', 'Snooze')} data-tip={L('稍后处理', 'Snooze')} onClick={(e) => menu.openBelow(e.currentTarget, laterOptions().map(([label, t]) => ({ label, icon: 'clock', run: () => s.later([m.id], t) })))}><Icon name="clock" /></button>
        <button className="tb" aria-label={L('删除', 'Delete')} data-tip={m.role === 'trash' ? L('彻底删除', 'Delete forever') : L('删除  Del', 'Delete  Del')} onClick={async () => (m.role === 'trash' ? await ask(L('彻底删除这封邮件？删除后无法恢复。', "Delete this email forever? This can't be undone.")) && s.removeForever([m.id]) : s.move([m.id], 'trash', L('删除', 'deleted')))}><Icon name="trash" /></button>
        <span className="mono" style={{ marginLeft: 'auto', marginRight: 2, fontSize: 12, color: 'var(--ter)' }}>{idx >= 0 ? `${idx + 1} / ${s.total}` : ''}</span>
        <button className="tb" aria-label={L('上一封', 'Previous')} data-tip={L('上一封  K', 'Previous  K')} disabled={idx <= 0} onClick={() => nav(-1)}><Icon name="up" /></button>
        <button className="tb" aria-label={L('下一封', 'Next')} data-tip={L('下一封  J', 'Next  J')} disabled={idx < 0 || idx >= s.items.length - 1} onClick={() => nav(1)}><Icon name="down" /></button>
        <button className="tb" aria-label={L('更多', 'More')} data-tip={L('更多', 'More')} onClick={(e) => menu.openBelow(e.currentTarget, [{ label: L('打印', 'Print'), icon: 'doc', run: () => printMail(m) }, 'sep', ...mailMenu(m, [m.id]).filter((x) => x === 'sep' || !['reply', 'replyAll', 'forward'].includes(x.icon ?? ''))])}><Icon name="more" /></button>
      </div>
      <div className="reader-scroll">
        <h2>{m.subject || L('（无主题）', '(no subject)')}</h2>
        {before.map((x) => <ThreadItem key={x.id} x={x} />)}
        <div ref={activeRef} className={inChain ? 'th-active' : undefined}>
        <div className="sender">
          <Avatar name={m.fromName} email={m.fromAddr} />
          <div style={{ fontSize: 13, lineHeight: 1.45, minWidth: 0, userSelect: 'text' }}>
            <b>{m.fromName || m.fromAddr}</b> {m.fromName && <span style={{ color: 'var(--ter)' }}>&lt;{m.fromAddr}&gt;</span>}
            <TipText className="truncate" style={{ fontSize: 12, color: 'var(--ter)' }}>
              {L('发给 ', 'To ')}{acc ? acc.label || acc.email : ''}{m.to.length > 0 && ` · ${m.to.map(addrText).join(L('，', ', '))}`}{m.cc.length > 0 && ` · ${L('抄送', 'Cc')} ${m.cc.map((a) => a.name || a.email).join(L('，', ', '))}`}
            </TipText>
          </div>
          <span className="mono" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ter)', whiteSpace: 'nowrap' }}>{fullTime(m.date)}</span>
        </div>

        {m.code && m.role !== 'sent' && m.role !== 'drafts' && <CodeNote code={m.code} />}
        {s.view.kind === 'followup' && m.role === 'sent' && !s.search && <FollowNote m={m} />}
        <AiCard m={m} />

        {m.atts.length > 0 && (
          <div className="att-row">
            {m.atts.map((a) => (
              <span key={a.idx} className="row" style={{ gap: 2 }}>
                <button className="att sq" title={L('用默认程序打开', 'Open with default app')} onClick={async () => {
                  try { await api.openAttachment(m.id, a.idx) } catch (e) { s.toast(errText(e), { kind: 'err', ttl: 8000 }) }
                }}>
                  <span className="ext">{(a.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase()}</span>
                  <span className="truncate" style={{ maxWidth: 220 }}>{a.name}</span>
                  <span className="num" style={{ color: 'var(--ter)' }}>{size(a.size)}</span>
                </button>
                <button className="tb" aria-label={L(`保存 ${a.name}`, `Save ${a.name}`)} data-tip={L('保存到「下载」', 'Save to Downloads')} onClick={async () => {
                  try { const p = await api.saveAttachment(m.id, a.idx); s.toast(L(`已保存到 ${p}`, `Saved to ${p}`)) } catch (e) { s.toast(errText(e), { kind: 'err' }) }
                }}><Icon name="download" size={15} /></button>
              </span>
            ))}
          </div>
        )}
        <MailBody m={m} key={m.id} />
        </div>
        {after.map((x) => <ThreadItem key={x.id} x={x} />)}
      </div>
      {menu.node}
    </section>
  )
}

/** 会话里当前这封之外的邮件：读过的折叠成一行，没读的展开正文。点一下设为当前邮件（回复、删除等操作针对它） */
function ThreadItem({ x }: { x: MsgLite }) {
  const s = useApp()
  const full = s.expanded[x.id]
  const name = x.role === 'sent' ? L('我', 'Me') : x.fromName || x.fromAddr
  const head = (
    <>
      <Avatar name={x.fromName} email={x.fromAddr} />
      <span className="th-who truncate">{name}</span>
      {!full && <span className="th-prev truncate">{x.aiSummary || x.snippet}</span>}
      <span className="mono th-time">{shortTime(x.date)}</span>
    </>
  )
  if (!full) return <button className={`th-item${!x.seen && x.role !== 'sent' ? ' unread' : ''}`} onClick={() => s.focusMsg(x.id)}>{head}</button>
  return (
    <div className="th-open">
      <button className="th-item" title={L('设为当前邮件（回复、删除等操作针对它）', 'Make this the current email (reply, delete and other actions apply to it)')} onClick={() => s.focusMsg(x.id)}>{head}</button>
      <MailBody m={full} key={full.id} />
    </div>
  )
}

/** 验证码邮件：把验证码单独列出来，点一下才复制（不自动写剪贴板） */
function CodeNote({ code }: { code: string }) {
  const s = useApp()
  const copy = async () => {
    let ok = false
    try {
      await navigator.clipboard.writeText(code)
      ok = true
    } catch {
      // 剪贴板接口用不了时退回老办法
      const t = document.createElement('textarea')
      t.value = code
      t.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(t)
      t.select()
      try { ok = document.execCommand('copy') } catch { ok = false }
      t.remove()
    }
    if (ok) s.toast(L(`已复制验证码 ${code}`, `Copied code ${code}`), { ttl: 2500 })
    else s.toast(L('没复制成功，请手动选中验证码复制', "Couldn't copy. Select the code and copy it manually."), { kind: 'err' })
  }
  return (
    <div className="remote-note sq">
      <Icon name="lock" size={15} />
      <span>{L('验证码', 'Code')}</span>
      <b className="mono" style={{ userSelect: 'text', color: 'var(--ink)', letterSpacing: 1 }}>{code}</b>
      <button className="btn link sm" style={{ marginLeft: 'auto' }} onClick={copy}>{L('复制验证码', 'Copy code')}</button>
    </div>
  )
}

/** 待跟进：发出几天对方没回。可以让 AI 写一封跟进，或者不再提醒 */
function FollowNote({ m }: { m: MsgFull }) {
  const s = useApp()
  const [busy, setBusy] = useState(false)
  const days = Math.max(1, Math.floor((Date.now() / 1000 - m.date) / 86400))
  const to = m.to.map((a) => a.email).join(', ')
  const acc = s.accounts.find((a) => a.id === m.accountId)
  const write = async () => {
    if (!s.aiConfigured || (acc && !acc.aiAllowed)) { s.openCompose('reply', m, { prefill: { to } }); return }
    setBusy(true)
    try { const body = await api.aiFollowup(m.id); s.openCompose('reply', m, { prefill: { to, body } }) } catch (e) { s.toast(errText(e), { kind: 'err' }) } finally { setBusy(false) }
  }
  const skip = async () => {
    try {
      await api.followupSet(m.id, true)
      s.toast(L('这封不再提醒跟进', "Won't remind you to follow up on this one"), { action: { label: L('撤销', 'Undo'), run: () => { api.followupSet(m.id, false).catch(() => {}) } }, ttl: 6000 })
    } catch (e) { s.toast(errText(e), { kind: 'err' }) }
  }
  return (
    <div className="follow-note sq">
      <Icon name="wait" size={15} />
      <span className="grow">{L(`发出 ${days} 天了，${m.to[0]?.name || m.to[0]?.email || '对方'}还没回。`, `Sent ${days} ${days === 1 ? 'day' : 'days'} ago. No reply from ${m.to[0]?.name || m.to[0]?.email || 'them'} yet.`)}</span>
      <button className="btn sm sq" disabled={busy} onClick={write}>{busy ? L('正在起草…', 'Drafting…') : s.aiConfigured && acc?.aiAllowed !== false ? L('让 AI 写跟进', 'Draft follow-up with AI') : L('写跟进', 'Write follow-up')}</button>
      <button className="btn link sm" onClick={skip}>{L('不用跟进', 'No follow-up needed')}</button>
    </div>
  )
}

function AiCard({ m }: { m: MsgFull }) {
  const s = useApp()
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const menu = useMenu()
  const ai = m.ai
  useEffect(() => setBusy(false), [m.id, ai?.state, ai?.model, ai?.error])

  if (!s.aiConfigured && !ai) return null
  if (ai && ai.state === 3) return null // 本地规则判为通知/广告，不显示批注
  const acc = s.accounts.find((a) => a.id === m.accountId)
  if (acc && !acc.aiAllowed) return null // 不用 AI 的账号：不显示批注，也不给「重新生成」「起草」的入口

  const running = busy || (!ai && m.aiPending)
  const regen = async () => {
    setBusy(true)
    try { await api.aiAnalyze(m.id) } catch (e) { setBusy(false); s.toast(errText(e), { kind: 'err' }) }
  }
  if (!ai && !running) {
    return (
      <div className="ai-card sq">
        <div className="row" style={{ padding: '8px 10px 8px 14px', gap: 10, fontSize: 12.5, color: 'var(--sec)' }}>
          <Icon name="sparkle" style={{ color: 'var(--accent)' }} />
          <span className="grow">{L('这封邮件还没有 AI 批注', 'No AI notes for this email yet')}{s.aiUsedToday >= (s.settings?.aiDailyLimit ?? 200) ? L('（今天的自动分析额度用完了）', " (today's automatic analysis limit is used up)") : ''}</span>
          <button className="btn sm sq" onClick={regen}>{L('让 AI 分析', 'Analyze with AI')}</button>
        </div>
      </div>
    )
  }
  const draftWith = async (tone: string) => {
    s.toast(L('正在起草…', 'Drafting…'), { ttl: 2500 })
    try {
      const text = await api.aiDraft(m.id, tone, ai?.replyLang || 'auto', '')
      s.openCompose('reply', m, { prefill: { body: text } })
    } catch (e) { s.toast(errText(e), { kind: 'err' }) }
  }

  if (ai && ai.state === 4 && !busy) {
    // 账号设成只分类：显示类别，想看摘要和建议回复再点完整分析
    return (
      <div className="ai-card sq">
        <div className="row" style={{ padding: '8px 10px 8px 14px', gap: 10, fontSize: 12.5 }}>
          <Icon name="sparkle" style={{ color: 'var(--accent)' }} />
          <span className="tag">{catLabel(ai.category)}{ai.priority === 'high' ? L(' · 高优先', ' · High priority') : ''}</span>
          <span className="grow truncate" style={{ color: 'var(--sec)' }}>{ai.reason}</span>
          <button className="btn sm sq" onClick={regen}>{L('完整分析', 'Full analysis')}</button>
        </div>
      </div>
    )
  }
  if (ai && ai.state === 2 && !busy) {
    return (
      <div className="ai-card sq">
        <div className="row" style={{ padding: '10px 14px', gap: 10, fontSize: 12.5 }}>
          <Icon name="alert" style={{ color: 'var(--amber-text)' }} />
          <span className="grow">{L('AI 这次没分析成功：', 'AI analysis failed: ')}{ai.error.slice(0, 120)}</span>
          <button className="btn sm" onClick={regen}>{L('重试', 'Retry')}</button>
        </div>
      </div>
    )
  }

  return (
    <div className="ai-card sq">
      <div className="ai-strip">
        {running ? <span style={{ color: '#F2A487', display: 'inline-flex' }}><Kojoo width={26} stroke={8} /></span> : <Icon name="sparkle" style={{ color: '#F2A487' }} />}
        <span className="t">{L('批注', 'AI notes')}</span>
        <TipText className="s truncate">{running ? L('正在读这封邮件…', 'Reading this email…') : ai!.reason || ai!.summary}</TipText>
        {!running && ai!.model && <span className="model">{ai!.model.replace(/^claude-/, '').replace(/-(\d)-(\d)$/, '-$1.$2')}</span>}
        {!running && <button className="tb" aria-label={collapsed ? L('展开批注', 'Expand AI notes') : L('收起批注', 'Collapse AI notes')} onClick={() => setCollapsed(!collapsed)}><Icon name={collapsed ? 'down' : 'up'} size={15} /></button>}
      </div>
      {running ? (
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="skel" style={{ height: 9, width: '90%' }} /><div className="skel" style={{ height: 9, width: '72%' }} /><div className="skel" style={{ height: 9, width: '55%' }} />
        </div>
      ) : !collapsed && (
        <>
          {ai!.facts.length > 0 && (
            <div className="facts">
              {ai!.facts.map((f, i) => (
                <div key={i} className={`fact sq${/期望|截止|期限|due|deadline/i.test(f.k) ? ' hl' : ''}`}><div className="k">{f.k}</div><TipText className="v">{f.v}</TipText></div>
              ))}
            </div>
          )}
          {ai!.summary && <div className="ai-summary">{ai!.summary}</div>}
          {m.todos.length > 0 && (
            <div className="todo-mini">
              {m.todos.map((t) => (
                <label key={t.id} className={`todo-line${t.done ? ' done' : ''}`}>
                  <input type="checkbox" className="check" checked={t.done} onChange={async (e) => { await api.todoSet(t.id, { done: e.target.checked }); s.reloadOpen(); s.refreshMeta() }} />
                  <span className="grow">{t.text}</span>
                  {t.due && !t.done && <span className="tag hot">{new Date(t.due * 1000).toDateString() === new Date().toDateString() ? L('今天', 'Today') : new Date(t.due * 1000).toLocaleDateString(EN ? 'en-US' : 'zh-CN', EN ? { month: 'short', day: 'numeric' } : { month: 'numeric', day: 'numeric' })}</span>}
                </label>
              ))}
            </div>
          )}
          {ai!.reply && (
            <>
              <div className="reply-box sq">
                <div className="k">{L('建议回复', 'Suggested reply')}{ai!.replyLang ? ` · ${(EN ? REPLY_LANG_EN : REPLY_LANG_ZH)[ai!.replyLang] || ai!.replyLang}` : ''}</div>
                <div className="v">{ai!.reply.length > 400 ? ai!.reply.slice(0, 400) + '…' : ai!.reply}</div>
              </div>
              <div className="ai-actions">
                <button className="btn primary sq" onClick={() => s.openCompose('reply', m, { prefill: { body: ai!.reply } })}>{L('填入回复', 'Use reply')}</button>
                <button className="btn sq" onClick={(e) => menu.openBelow(e.currentTarget, [
                  { label: L('专业得体', 'Professional'), run: () => draftWith('pro') },
                  { label: L('友好亲切', 'Friendly'), run: () => draftWith('friendly') },
                  { label: L('简洁直接', 'Concise'), run: () => draftWith('brief') },
                ])}>{L('换个语气', 'Change tone')}</button>
                <button className="tb" aria-label={L('重新生成', 'Regenerate')} data-tip={L('用精细模型重新分析', 'Re-analyze with the detailed model')} data-tip-pos="up" onClick={regen}><Icon name="refresh" /></button>
              </div>
            </>
          )}
          {!ai!.reply && (
            <div className="ai-actions" style={{ justifyContent: 'flex-end', paddingTop: 2 }}>
              <button className="btn sm sq" onClick={() => draftWith('pro')}>{L('让 AI 起草回复', 'Draft reply with AI')}</button>
              <button className="tb" aria-label={L('重新生成', 'Regenerate')} data-tip={L('用精细模型重新分析', 'Re-analyze with the detailed model')} data-tip-pos="up" onClick={regen}><Icon name="refresh" /></button>
            </div>
          )}
        </>
      )}
      {menu.node}
    </div>
  )
}

/** 邮件 HTML 清洗后包成独立文档：去脚本和表单，CSP 拦远程资源（allowRemote 时放行图片） */
function mailDoc(html: string, allowRemote: boolean, head = '') {
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'frame', 'frameset'],
    FORBID_ATTR: ['srcset'],
    ADD_ATTR: ['target'],
  })
  const img = allowRemote ? 'data: https: http:' : 'data:'
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:">`
  const base = `<style>html,body{margin:0;padding:0;background:#fff;color:#1F2A37;font:14px/1.6 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;word-break:break-word}img{max-width:100%;height:auto}a{color:#1B4A80}table{max-width:100%}pre{white-space:pre-wrap}</style>`
  const out = clean.replace(/<head[^>]*>/i, (h) => h + csp + base).replace(/^(?![\s\S]*<head)/, csp + base)
  return head ? out.replace(/<body[^>]*>/i, (b) => b + head) : out
}

/** 文字里像网址或域名的部分，取主机名（小写、去 www.） */
function hostIn(t: string): string {
  const m = t.trim().match(/^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]|$)/i)
  return m ? m[1].toLowerCase().replace(/^www\./, '') : ''
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** 打印：信头 + 正文放进一个临时的隐藏框，调系统打印对话框（不加载远程图片） */
function printMail(m: MsgFull) {
  const who = (a: { name?: string; email: string }) => esc(a.name ? `${a.name} <${a.email}>` : a.email)
  const head = `<div style="font:13px/1.7 'Segoe UI','Microsoft YaHei',sans-serif;color:#1F2A37;border-bottom:1px solid #ccc;padding-bottom:10px;margin-bottom:16px">
<div style="font-size:18px;font-weight:600;margin-bottom:6px">${esc(m.subject || L('（无主题）', '(no subject)'))}</div>
<div>${L('发件人：', 'From: ')}${who({ name: m.fromName, email: m.fromAddr })}</div>
${m.to.length ? `<div>${L('收件人：', 'To: ')}${m.to.map(who).join(L('，', ', '))}</div>` : ''}${m.cc.length ? `<div>${L('抄送：', 'Cc: ')}${m.cc.map(who).join(L('，', ', '))}</div>` : ''}
<div>${L('时间：', 'Date: ')}${esc(fullTime(m.date))}</div></div>`
  const body = m.html || `<html><body><pre style="font:14px/1.7 'Segoe UI','Microsoft YaHei',sans-serif;white-space:pre-wrap">${esc(m.text)}</pre></body></html>`
  if (IS_MAC) {
    // WKWebView 里页面调不出打印：在浏览器里打开，那边 ⌘P（提示条打印时不出现）
    const tip = `<div class="kjm-tip" style="font:13px -apple-system,sans-serif;background:#FFF6D6;padding:8px 12px;margin-bottom:12px;border-radius:6px">${L('按 ⌘P 打印这封邮件', 'Press ⌘P to print this email')}</div><style>@media print{.kjm-tip{display:none}}</style>`
    api.printHtml(mailDoc(body, false, tip + head)).catch(() => {})
    return
  }
  const f = document.createElement('iframe')
  f.setAttribute('sandbox', 'allow-same-origin allow-modals')
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  f.srcdoc = mailDoc(body, false, head)
  f.onload = () => {
    const w = f.contentWindow
    if (!w) { f.remove(); return }
    // print() 在 WebView2 里可能马上返回、预览还在生成：等打印对话框关掉（afterprint）再拆，最多留 10 分钟
    const done = () => f.remove()
    w.addEventListener('afterprint', done)
    setTimeout(done, 600000)
    w.print()
  }
  document.body.appendChild(f)
}

const REPLY_LANG_ZH: Record<string, string> = { en: '英文', zh: '中文', it: '意大利语', de: '德语', fr: '法语', es: '西班牙语', ja: '日语' }
const REPLY_LANG_EN: Record<string, string> = { en: 'English', zh: 'Chinese', it: 'Italian', de: 'German', fr: 'French', es: 'Spanish', ja: 'Japanese' }

const REMOTE_RE = /<img[^>]+src\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:/i

function MailBody({ m }: { m: MsgFull }) {
  const s = useApp()
  const frame = useRef<HTMLIFrameElement>(null)
  const [allowRemote, setAllowRemote] = useState(false)
  const [height, setHeight] = useState(80)
  const [tr, setTr] = useState<{ busy: boolean; on: boolean; err: string }>({ busy: false, on: false, err: '' })
  const [plain, setPlain] = useState<string | null>(null)
  const origs = useRef<{ n: Text; t: string }[]>([])
  const curId = useRef(m.id)
  const docVer = useRef(0)
  curId.current = m.id
  const trLang = EN ? 'en' : 'zh'
  useEffect(() => { setAllowRemote(s.settings?.remoteImages === 'always'); setHeight(80); setPlain(null) }, [m.id])

  const hasRemote = useMemo(() => REMOTE_RE.test(m.html), [m.html])
  const doc = useMemo(() => (m.html ? mailDoc(m.html, allowRemote) : ''), [m.html, allowRemote])
  // 换邮件或正文重新载入（显示图片）后，译文状态作废
  useEffect(() => { origs.current = []; docVer.current++; setTr({ busy: false, on: false, err: '' }) }, [m.id, doc])

  const acc = s.accounts.find((a) => a.id === m.accountId)
  const canTr = s.aiConfigured && acc?.aiAllowed !== false
  const runTr = async () => {
    if (tr.busy) return
    const id = m.id
    if (tr.on) {
      origs.current.forEach(({ n, t }) => { n.nodeValue = t })
      origs.current = []
      setPlain(null)
      setTr({ busy: false, on: false, err: '' })
      return
    }
    setTr({ busy: true, on: false, err: '' })
    const snapVer = docVer.current
    try {
      if (m.html) {
        const d = frame.current?.contentDocument
        if (!d?.body) throw new Error(L('正文还没加载好', 'The body is still loading'))
        const nodes: { n: Text; t: string }[] = []
        const w = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT)
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const p = n.parentElement?.tagName
          if (p === 'STYLE' || p === 'SCRIPT' || p === 'TITLE') continue
          const t = n.nodeValue || ''
          if (t.trim()) nodes.push({ n: n as Text, t })
        }
        if (!nodes.length) throw new Error(L('没有可翻译的文字', 'Nothing to translate'))
        const out = await api.aiTranslate(id, trLang, nodes.map((x) => x.t.trim()))
        if (curId.current !== id || docVer.current !== snapVer) return
        nodes.forEach(({ n, t }, i) => {
          const lead = t.match(/^\s*/)![0]
          const trail = t.match(/\s*$/)![0]
          n.nodeValue = lead + (out[i] ?? t.trim()) + trail
        })
        origs.current = nodes
      } else {
        const lines = m.text.split('\n')
        const idxs = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0)
        if (!idxs.length) throw new Error(L('没有可翻译的文字', 'Nothing to translate'))
        const out = await api.aiTranslate(id, trLang, idxs.map((i) => lines[i].trim()))
        if (curId.current !== id || docVer.current !== snapVer) return
        idxs.forEach((i, k) => { lines[i] = out[k] ?? lines[i] })
        setPlain(lines.join('\n'))
      }
      setTr({ busy: false, on: true, err: '' })
    } catch (err) {
      if (curId.current === id && docVer.current === snapVer) setTr({ busy: false, on: false, err: errText(err) })
    }
  }
  const bar = canTr ? (
    <div className="tr-note sq">
      <Icon name="sparkle" size={15} />
      <span className="grow">{tr.err ? L('翻译没成功：', 'Translation failed: ') + tr.err.slice(0, 120) : tr.busy ? L('正在翻译…', 'Translating…') : tr.on ? <span className="tr-sub">{L('已翻译，原有排版保留', 'Translated, original layout kept')}</span> : ''}</span>
      <button className="btn link sm" disabled={tr.busy} onClick={runTr}>{tr.on ? L('显示原文', 'Show original') : trLang === 'zh' ? '翻译成中文' : 'Translate to English'}</button>
    </div>
  ) : null

  const ro = useRef<ResizeObserver | null>(null)
  useEffect(() => () => ro.current?.disconnect(), [])

  const onClick = async (e: MouseEvent) => {
    const a = (e.target as Element).closest('a')
    if (!a) return
    e.preventDefault()
    const href = (a.getAttribute('href') || '').trim()
    // 钓鱼常见手法：显示的是一个网址，点过去是另一个网站
    const shown = hostIn(a.textContent || '')
    const real = hostIn(href)
    if (shown && real && shown !== real && !real.endsWith(`.${shown}`) && !await ask(L(`链接上写的是 ${shown}，实际会打开 ${real}。\n\n可能是钓鱼链接，确定要打开吗？`, `The link says ${shown} but actually opens ${real}.\n\nThis may be a phishing link. Open it anyway?`))) return
    if (/^mailto:/i.test(href)) {
      s.openCompose('new', null, { prefill: { to: decodeURIComponent(href.slice(7).split('?')[0]) } })
    } else if (/^https?:/i.test(href)) {
      api.openUrl(href).catch((err) => s.toast(L(`链接打不开：${errText(err)}`, `Couldn't open the link: ${errText(err)}`), { kind: 'err' }))
    }
  }
  // 用 iframe 自己的 onLoad（元素一创建就挂上）：在 useEffect 里再挂 load 监听，正文载入快时会错过，点链接就没反应
  const onLoad = () => {
    const d = frame.current?.contentDocument
    if (!d) return
    const fit = () => setHeight(Math.max(60, Math.min(d.documentElement.scrollHeight, 40000)))
    fit()
    ro.current?.disconnect()
    ro.current = new ResizeObserver(fit)
    ro.current.observe(d.documentElement)
    d.addEventListener('click', (e) => { onClickRef.current(e) })
  }
  // 监听挂在文档上只挂一次，通过 ref 调最新的处理函数
  const onClickRef = useRef(onClick)
  onClickRef.current = onClick

  if (!m.html) {
    return <>{bar}<div style={{ marginTop: 18, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--body-size)', lineHeight: 1.75, color: 'var(--ink-2)', userSelect: 'text', maxWidth: 760 }}>{linkify(plain ?? m.text)}</div></>
  }
  return (
    <>
      {bar}
      {hasRemote && !allowRemote && (
        <div className="remote-note sq">
          <Icon name="image" size={15} />{L('为保护隐私，已拦截远程图片（发件人可以靠它知道你读了信）', 'Remote images blocked for privacy (senders can use them to see that you opened the email)')}
          <button className="btn link sm" style={{ marginLeft: 'auto' }} onClick={() => setAllowRemote(true)}>{L('显示图片', 'Show images')}</button>
        </div>
      )}
      {/* HTML 邮件按白底写的：两种主题都放进白色卡片，边界清楚 */}
      <div className="mail-sheet">
        <iframe ref={frame} className="mail-frame" title={L('邮件正文', 'Email body')} sandbox="allow-same-origin" srcDoc={doc} onLoad={onLoad} style={{ height }} />
      </div>
    </>
  )
}

function linkify(text: string) {
  const parts = text.split(/(https?:\/\/[^\s<>"'）)]+)/g)
  return parts.map((p, i) =>
    /^https?:\/\//.test(p) ? <a key={i} href={p} onClick={(e) => { e.preventDefault(); api.openUrl(p) }}>{p}</a> : p,
  )
}

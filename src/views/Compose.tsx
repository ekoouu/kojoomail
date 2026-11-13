import { useEffect, useMemo, useRef, useState } from 'react'
import { ask } from '../lib/ask'
import { open as pickFiles } from '@tauri-apps/plugin-dialog'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { Icon } from '../icons'
import { useApp, pendingSends } from '../store'
import { api, errText, type Addr, type DraftIn } from '../lib/api'
import { parseAddrs, validEmail, fullTime } from '../lib/format'
import { mdPreview, mdToHtml, quoteText } from '../lib/md'
import { Seg, Sheet, useMenu } from '../ui'
import { keyText } from '../lib/platform'
import { L, EN } from '../lib/i18n'

type Field = 'to' | 'cc' | 'bcc'

export default function Compose() {
  const s = useApp()
  const c = s.compose!
  const base = c.base || null
  const me = (id: number) => s.accounts.find((a) => a.id === id)

  const initial = useMemo(() => {
    const accountId = c.prefill?.accountId ?? base?.accountId ?? s.settings?.defaultAccount ?? s.accounts[0]?.id
    const self = new Set(s.accounts.map((a) => a.email.toLowerCase()))
    let to: Addr[] = [], cc: Addr[] = [], subject = '', quote = ''
    if (base && (c.mode === 'reply' || c.mode === 'replyAll')) {
      to = [base.replyTo ? { name: '', email: base.replyTo } : { name: base.fromName, email: base.fromAddr }]
      if (c.mode === 'replyAll') {
        const seen = new Set(to.map((a) => a.email.toLowerCase()))
        cc = [...base.to, ...base.cc].filter((a) => { const k = a.email.toLowerCase(); if (self.has(k) || seen.has(k)) return false; seen.add(k); return true })
      }
      subject = /^re:/i.test(base.subject) ? base.subject : `Re: ${base.subject}`
      quote = quoteText(base.text, EN ? `On ${fullTime(base.date)}, ${base.fromName ? `${base.fromName} <${base.fromAddr}>` : base.fromAddr} wrote:` : `在 ${fullTime(base.date)}，${base.fromName || base.fromAddr} 写道：`)
    } else if (base && c.mode === 'forward') {
      subject = /^(fwd?|转发):/i.test(base.subject) ? base.subject : `Fwd: ${base.subject}`
      quote = EN
        ? `\n\n---------- Forwarded message ----------\nFrom: ${base.fromName} <${base.fromAddr}>\nDate: ${fullTime(base.date)}\nSubject: ${base.subject}\n\n${base.text}`
        : `\n\n---------- 转发的邮件 ----------\n发件人：${base.fromName} <${base.fromAddr}>\n时间：${fullTime(base.date)}\n主题：${base.subject}\n\n${base.text}`
    }
    if (c.prefill?.to) to = parseAddrs(c.prefill.to)
    if (c.prefill?.subject != null) subject = c.prefill.subject
    const d = c.draft
    if (d) {
      // 草稿里存的正文已经带着引用，原样恢复
      return { accountId: d.accountId || accountId, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, body: d.body, quote: '', files: d.attachments || [], replyMsg: d.replyMsg ?? null, mode: d.mode || 'new' }
    }
    const sig = accountId ? me(accountId)?.signature : ''
    const body = (c.prefill?.body ?? '') + (sig && !c.prefill?.body ? `\n\n${sig}` : '')
    return { accountId, to, cc, bcc: [] as Addr[], subject, body, quote, files: [] as string[], replyMsg: base?.id ?? null, mode: c.mode === 'draft' ? 'new' : c.mode }
  }, [c.key])

  const [accountId, setAccountId] = useState<number>(initial.accountId!)
  const [rc, setRc] = useState<Record<Field, Addr[]>>({ to: initial.to, cc: initial.cc, bcc: initial.bcc })
  const [showCc, setShowCc] = useState(initial.cc.length > 0 || initial.bcc.length > 0)
  const [subject, setSubject] = useState(initial.subject)
  const [body, setBody] = useState(initial.body)
  const [showQuote, setShowQuote] = useState(false)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [files, setFiles] = useState<string[]>(initial.files)
  const [dragging, setDragging] = useState(false)
  const [draftId, setDraftId] = useState<number | null>(c.draftId ?? null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [aiOpen, setAiOpen] = useState(s.aiConfigured)
  const [aiBusy, setAiBusy] = useState('')
  const [tone, setTone] = useState('pro')
  const dirty = useRef(false)
  const sending = useRef(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const menu = useMenu()

  const draft = (): DraftIn => ({
    id: draftId, accountId, to: rc.to, cc: rc.cc, bcc: rc.bcc, subject,
    body: body + (initial.quote ? initial.quote : ''), html: '', replyMsg: initial.replyMsg, mode: initial.mode, attachments: files,
  })

  // 自动存草稿：停止输入 2 秒后
  useEffect(() => {
    if (!dirty.current) return
    const t = setTimeout(async () => {
      try { const id = await api.saveDraft(draft()); setDraftId(id); setSavedAt(Date.now()) } catch { /* 忽略 */ }
    }, 2000)
    return () => clearTimeout(t)
  }, [rc, subject, body, accountId, files])
  const touch = () => { dirty.current = true }

  // 拖文件进窗口 = 添加附件
  useEffect(() => {
    let un: (() => void) | undefined
    getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === 'enter' || e.payload.type === 'over') setDragging(true)
      else if (e.payload.type === 'leave') setDragging(false)
      else if (e.payload.type === 'drop') { const paths: string[] = e.payload.paths; setDragging(false); setFiles((f) => [...f, ...paths.filter((p) => !f.includes(p))]) }
    }).then((f) => { un = f })
    return () => un?.()
  }, [])

  useEffect(() => { setTimeout(() => (rc.to.length ? bodyRef.current : document.getElementById('c-to'))?.focus(), 50) }, [])

  const close = async () => {
    if (dirty.current && (body.trim() || subject.trim() || rc.to.length)) {
      try { await api.saveDraft(draft()); s.toast(L('已存为草稿', 'Saved as draft')) } catch { /* */ }
    }
    s.set({ compose: null })
    s.refreshMeta()
  }
  // 格式按钮：在光标处插 Markdown 标记（发送时排版）。改完把光标放回去
  const edit = (next: string, a: number, b: number) => {
    setBody(next); touch()
    requestAnimationFrame(() => { const t = bodyRef.current; if (t) { t.focus(); t.setSelectionRange(a, b) } })
  }
  const wrap = (l: string, r: string, ph: string) => {
    const t = bodyRef.current
    if (!t) return
    const [a, b] = [t.selectionStart, t.selectionEnd]
    const sel = body.slice(a, b) || ph
    edit(body.slice(0, a) + l + sel + r + body.slice(b), a + l.length, a + l.length + sel.length)
  }
  const prefix = (p: string) => {
    const t = bodyRef.current
    if (!t) return
    const [a, b] = [t.selectionStart, t.selectionEnd]
    const start = a === 0 ? 0 : body.lastIndexOf('\n', a - 1) + 1
    const lines = body.slice(start, b).split('\n')
    const out = lines.map((x, i) => (p === '1. ' ? `${i + 1}. ` : p) + x).join('\n')
    edit(body.slice(0, start) + out + body.slice(b), start + out.length, start + out.length)
  }
  // 提示条里的按钮可能几秒后才点：那时要用最新的 close（存最新的草稿）
  const closeRef = useRef(close)
  closeRef.current = close
  const discard = async () => {
    if (draftId) await api.deleteDraft(draftId).catch(() => {})
    s.set({ compose: null })
    s.refreshMeta()
  }

  const placeholders = (body.match(/\[[^\]\n]{1,30}\]/g) || []).filter((p) => !/^\[[xX ]\]$/.test(p))
  const facts = base?.ai?.facts || []

  const send = async () => {
    if (sending.current) return // 防止连按两次 Ctrl+Enter 发两封
    sending.current = true
    try { await doSend() } finally { sending.current = false }
  }
  const doSend = async () => {
    const all = [...rc.to, ...rc.cc, ...rc.bcc]
    if (!rc.to.length) { s.toast(L('请填写收件人', 'Add a recipient'), { kind: 'err' }); return }
    const bad = all.find((a) => !validEmail(a.email))
    if (bad) { s.toast(L(`收件地址不对：${bad.email}`, `Invalid address: ${bad.email}`), { kind: 'err' }); return }
    if (placeholders.length && !await ask(L(`正文里还有 ${placeholders.length} 处没填的占位，比如 ${placeholders[0]}。确定发送吗？`, `The message still has ${placeholders.length} unfilled ${placeholders.length === 1 ? 'placeholder' : 'placeholders'}, such as ${placeholders[0]}. Send anyway?`))) return
    if (!subject.trim() && !await ask(L('没有主题，确定发送吗？', 'No subject. Send anyway?'))) return
    const d = draft()
    try { await api.precheckSend(d) } catch (e) { s.toast(errText(e), { kind: 'err', ttl: 8000 }); return }
    d.html = mdToHtml(d.body)
    // 先存草稿：发送失败或撤销时内容不会丢
    try { d.id = await api.saveDraft({ ...d, html: '' }) } catch { /* */ }
    s.set({ compose: null })
    const secs = s.settings?.undoSendSecs ?? 5
    let cancelled = false
    let left = secs
    let lastToast = 0
    const reopen = () => s.openCompose('draft', null, { draftId: d.id, draft: { ...d, html: '' } })
    const show = () => { if (lastToast) s.drop(lastToast); lastToast = s.toast(L(`正在发送… `, `Sending… `), { action: { label: L(`撤销 ${left}`, `Undo ${left}`), run: () => { cancelled = true; reopen() } }, ttl: 1100 }) }
    if (secs > 0) {
      // 倒计时期间不能重新加载界面（换语言），否则信就停在草稿里发不出去
      pendingSends.n++
      try {
        show()
        for (; left > 1; ) {
          await new Promise((r) => setTimeout(r, 1000))
          if (cancelled) return
          left--
          show()
        }
        await new Promise((r) => setTimeout(r, 1000))
        if (cancelled) return
      } finally { pendingSends.n-- }
    }
    pendingSends.n++
    try {
      await api.send(d)
      s.toast(L('已发送', 'Sent'))
      s.refreshMeta()
    } catch (e) {
      s.toast(L(`发送失败，已存回草稿：${errText(e)}`, `Couldn't send. Saved back to drafts: ${errText(e)}`), { kind: 'err', ttl: 8000, action: { label: L('打开', 'Open'), run: reopen } })
    } finally { pendingSends.n-- }
  }

  const rewrite = async (op: string, arg = '') => {
    if (!body.trim()) { s.toast(L('先写点内容', 'Write something first')); return }
    setAiBusy(op)
    try { const t = await api.aiRewrite(body, op, arg); setBody(t); touch() } catch (e) { s.toast(errText(e), { kind: 'err' }) } finally { setAiBusy('') }
  }
  const aiDraft = async () => {
    if (!base) return
    setAiBusy('draft')
    try { const t = await api.aiDraft(base.id, tone, base.ai?.replyLang || 'auto', body.trim() ? `参考我已经写的内容：${body.slice(0, 500)}` : ''); setBody(t); touch() } catch (e) { s.toast(errText(e), { kind: 'err' }) } finally { setAiBusy('') }
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send() } }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const title = c.mode === 'reply' || c.mode === 'replyAll' ? L(`回复 ${base?.fromName || base?.fromAddr || ''}`, `Reply to ${base?.fromName || base?.fromAddr || ''}`) : c.mode === 'forward' ? L('转发', 'Forward') : L('新邮件', 'New email')

  return (
    <Sheet onClose={close} className="compose" label={title} pinned>
      <div className="c-bar" data-tauri-drag-region>
        <button className="btn primary sq" onClick={send}><Icon name="send" size={15} />{L('发送', 'Send')}</button>
        <span style={{ width: .5, height: 18, background: 'var(--line)', margin: '0 6px' }} />
        <button className="tb" aria-label={L('添加附件', 'Attach files')} data-tip={L('添加附件', 'Attach files')} onClick={async () => {
          const r = await pickFiles({ multiple: true, title: L('选择附件', 'Choose attachments') }).catch(() => null)
          if (r) setFiles((f) => [...f, ...(Array.isArray(r) ? r : [r]).filter((p) => !f.includes(p))])
        }}><Icon name="clip" /></button>
        <button className="tb" aria-label={L('舍弃草稿', 'Discard draft')} data-tip={L('舍弃草稿', 'Discard draft')} onClick={async () => { if (!body.trim() || await ask(L('舍弃这封草稿？', 'Discard this draft?'))) discard() }}><Icon name="trash" /></button>
        <div className="grow truncate" data-tauri-drag-region style={{ textAlign: 'center', fontSize: 13, fontWeight: 600 }}>{title}</div>
        {s.aiConfigured ? (
          <button className="btn sm sq" style={{ background: aiOpen ? 'var(--sel)' : 'transparent', boxShadow: 'none' }} aria-pressed={aiOpen} onClick={() => setAiOpen(!aiOpen)}><Icon name="sparkle" size={15} />{L('AI 助手', 'AI assistant')}</button>
        ) : (
          <button className="btn sm sq" style={{ background: 'transparent', boxShadow: 'none', color: 'var(--sec)' }} data-tip={L('改写、翻译、核对要点要先设置 AI', 'Set up AI to rewrite, translate and fact check')} onClick={() => s.toast(L('还没设置 AI', "AI isn't set up yet"), { action: { label: L('存草稿并去设置', 'Save draft and set up'), run: async () => { if (useApp.getState().compose?.key === c.key) await closeRef.current(); s.openAiSettings() } }, ttl: 6000 })}><Icon name="sparkle" size={15} />{L('AI 助手', 'AI assistant')}</button>
        )}
        <button className="tb" aria-label={L('关闭（自动存草稿）', 'Close (saves draft)')} data-tip={L('关闭，自动存草稿', 'Close and save draft')} onClick={close}><Icon name="x" /></button>
      </div>
      <div className="c-main">
        <div className="c-edit" style={{ position: 'relative' }}>
          <div className="c-field">
            <span className="k">{L('发件人', 'From')}</span>
            <select value={accountId} onChange={(e) => {
              const next = Number(e.target.value)
              const oldSig = me(accountId)?.signature || ''
              const newSig = me(next)?.signature || ''
              if (oldSig !== newSig) {
                if (oldSig && body.endsWith(`\n\n${oldSig}`)) setBody(body.slice(0, -oldSig.length - 2) + (newSig ? `\n\n${newSig}` : ''))
                else if (!oldSig && newSig && !body.includes(newSig)) setBody(`${body}\n\n${newSig}`)
              }
              setAccountId(next); touch()
            }} className="field" style={{ width: 'auto', height: 28, fontSize: 13, padding: '0 8px', maxWidth: '100%' }} aria-label={L('发件账号', 'Sending account')}>
              {s.accounts.map((a) => <option key={a.id} value={a.id}>{(a.label ? `${a.label} · ` : '') + a.email}</option>)}
            </select>
          </div>
          <Recipients id="c-to" label={L('收件人', 'To')} list={rc.to} onChange={(v) => { setRc({ ...rc, to: v }); touch() }} extra={!showCc && <button className="btn link sm" onClick={() => setShowCc(true)}>{L('抄送 · 密送', 'Cc · Bcc')}</button>} />
          {showCc && <Recipients label={L('抄送', 'Cc')} list={rc.cc} onChange={(v) => { setRc({ ...rc, cc: v }); touch() }} />}
          {showCc && <Recipients label={L('密送', 'Bcc')} list={rc.bcc} onChange={(v) => { setRc({ ...rc, bcc: v }); touch() }} />}
          <div className="c-field"><span className="k">{L('主题', 'Subject')}</span><input value={subject} onChange={(e) => { setSubject(e.target.value); touch() }} aria-label={L('主题', 'Subject')} style={{ fontWeight: 500 }} /></div>
          <div className="row" style={{ padding: '10px 24px 0', gap: 10 }}>
            <Seg small value={mode} onChange={setMode} options={[['edit', L('编辑', 'Edit')], ['preview', L('预览', 'Preview')]]} />
            <span className="row" style={{ gap: 5, fontSize: 12, color: 'var(--sec)' }}><Icon name="markdown" size={16} />{L('支持 Markdown，发送时自动排版', 'Markdown supported, formatted when sent')}</span>
            {mode === 'edit' && (
              <span className="row" style={{ marginLeft: 'auto', gap: 2 }}>
                {([['B', L('粗体', 'Bold'), () => wrap('**', '**', L('粗体', 'bold'))], ['I', L('斜体', 'Italic'), () => wrap('*', '*', L('斜体', 'italic'))], ['•', L('列表', 'Bulleted list'), () => prefix('- ')], ['1.', L('编号', 'Numbered list'), () => prefix('1. ')], ['❝', L('引用', 'Quote'), () => prefix('> ')], ['🔗', L('链接', 'Link'), () => wrap('[', '](https://)', L('链接文字', 'link text'))]] as [string, string, () => void][]).map(([t, tip, run]) => (
                  <button key={tip} className="tb" style={{ width: 26, height: 26, fontSize: 12.5, fontWeight: t === 'B' ? 700 : 500, fontStyle: t === 'I' ? 'italic' : undefined }} aria-label={tip} data-tip={tip} onMouseDown={(e) => e.preventDefault()} onClick={run}>{t}</button>
                ))}
              </span>
            )}
          </div>
          {mode === 'edit' ? (
            <textarea ref={bodyRef} value={body} onChange={(e) => { setBody(e.target.value); touch() }} placeholder={L('写点什么…', 'Write something…')} aria-label={L('正文', 'Message body')} spellCheck={false} />
          ) : (
            <div className="preview" dangerouslySetInnerHTML={{ __html: mdPreview(body) || `<p style="color:var(--ter)">${L('（空）', '(empty)')}</p>` }} />
          )}
          {initial.quote && (
            <div style={{ padding: '0 24px 8px' }}>
              <button className="btn sm sq" style={{ background: 'var(--well)', boxShadow: 'none', color: 'var(--sec)' }} onClick={() => setShowQuote(!showQuote)}>
                {showQuote ? L('收起引用的原邮件', 'Hide original email') : L(`··· 显示${c.mode === 'forward' ? '转发' : '引用'}的原邮件`, `··· Show ${c.mode === 'forward' ? 'forwarded' : 'quoted'} email`)}
              </button>
              {showQuote && <pre style={{ margin: '8px 0 0', maxHeight: 160, overflow: 'auto', fontFamily: 'var(--sans)', fontSize: 12.5, color: 'var(--sec)', whiteSpace: 'pre-wrap', borderLeft: '2px solid var(--line)', paddingLeft: 10 }}>{initial.quote.trim()}</pre>}
            </div>
          )}
          <div className="c-foot">
            {files.map((f) => {
              const name = f.split(/[\\/]/).pop() || f
              return (
                <span key={f} className="att sq" style={{ cursor: 'default' }}>
                  <span className="ext">{(name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase()}</span>
                  <span className="truncate" style={{ maxWidth: 200 }}>{name}</span>
                  <button className="tb" style={{ width: 20, height: 20 }} aria-label={L(`移除 ${name}`, `Remove ${name}`)} onClick={() => setFiles(files.filter((x) => x !== f))}><Icon name="x" size={12} /></button>
                </span>
              )
            })}
            {base && c.mode === 'forward' && base.atts.length > 0 && <span style={{ fontSize: 12, color: 'var(--sec)' }}>{L(`会带上原邮件的 ${base.atts.length} 个附件`, `Includes ${base.atts.length} ${base.atts.length === 1 ? 'attachment' : 'attachments'} from the original`)}</span>}
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ter)' }}>
              {savedAt ? L(`草稿已保存 ${new Date(savedAt).toTimeString().slice(0, 5)}　·　`, `Draft saved ${new Date(savedAt).toTimeString().slice(0, 5)}  ·  `) : ''}<span className="mono">{keyText('Ctrl ↵')}</span> {L('发送', 'to send')}
            </span>
          </div>
          {dragging && <div className="drop"><Icon name="clip" size={24} /><b>{L('松开即可添加附件', 'Drop to attach')}</b><span style={{ fontSize: 12 }}>{me(accountId)?.provider === 'outlook' && me(accountId)?.auth === 'oauth' ? L('Outlook 单封附件最多约 2 MB', 'Outlook allows about 2 MB of attachments per email') : L('单封邮件附件最多 25 MB', 'Up to 25 MB of attachments per email')}</span></div>}
        </div>

        {aiOpen && s.aiConfigured && (
          <aside className="ai-side">
            {base && (
              <div>
                <div className="h" style={{ fontSize: 11, fontWeight: 600, color: 'var(--ter)', margin: '0 0 8px 4px' }}>{L('语气', 'Tone')}</div>
                <Seg value={tone} onChange={setTone} options={[['pro', L('专业', 'Professional')], ['friendly', L('友好', 'Friendly')], ['brief', L('简洁', 'Concise')]]} />
                <button className="btn sq" style={{ width: '100%', marginTop: 8 }} disabled={!!aiBusy} onClick={aiDraft}>{aiBusy === 'draft' ? L('正在起草…', 'Drafting…') : body.trim() ? L('按这个语气重写回复', 'Rewrite reply in this tone') : L('起草回复', 'Draft reply')}</button>
              </div>
            )}
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ter)', margin: '0 0 4px 4px' }}>{L('改写', 'Rewrite')}</div>
              <button className="act sq" disabled={!!aiBusy} onClick={() => rewrite('polish')}><Icon name="pen" style={{ color: 'var(--sec)' }} />{aiBusy === 'polish' ? L('正在润色…', 'Polishing…') : L('润色全文', 'Polish')}</button>
              <button className="act sq" disabled={!!aiBusy} onClick={(e) => menu.openBelow(e.currentTarget, TRANSLATE_TO.map(([l, en]) => ({ label: L(l, en), run: () => rewrite('translate', l) })))}>
                <Icon name="translate" style={{ color: 'var(--sec)' }} />{aiBusy === 'translate' ? L('正在翻译…', 'Translating…') : L('翻译成…', 'Translate to…')}
              </button>
              <button className="act sq" disabled={!!aiBusy} onClick={() => rewrite('shorten')}><Icon name="lines" style={{ color: 'var(--sec)' }} />{aiBusy === 'shorten' ? L('正在缩短…', 'Shortening…') : L('缩短一半', 'Shorten')}</button>
              {!base && <button className="act sq" disabled={!!aiBusy} onClick={() => rewrite('tone', tone)}><Icon name="sparkle" style={{ color: 'var(--sec)' }} />{L(`改成${tone === 'friendly' ? '友好' : tone === 'brief' ? '简洁' : '专业'}语气`, `Make it ${tone === 'friendly' ? 'friendly' : tone === 'brief' ? 'concise' : 'professional'}`)}</button>}
            </div>
            {(facts.length > 0 || placeholders.length > 0) && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ter)', margin: '0 0 8px 4px' }}>{L('要点核对', 'Fact check')}</div>
                <div className="group sq" style={{ padding: '4px 12px', fontSize: 12.5 }}>
                  {facts.map((f, i) => {
                    const ok = body.toLowerCase().includes(f.v.toLowerCase().replace(/\s+sets?$/, '').split(/[,，\s]/)[0]?.toLowerCase() || '###')
                    return (
                      <div key={i} className="row" style={{ minHeight: 32, borderTop: i ? '.5px solid var(--line-2)' : undefined, color: ok ? undefined : 'var(--sec)' }}>
                        <Icon name={ok ? 'check' : 'info'} size={15} style={{ color: ok ? 'var(--green-text)' : 'var(--ter)' }} />{f.k}{L('：', ': ')}{f.v}
                      </div>
                    )
                  })}
                  {placeholders.length > 0 && (
                    <div className="row" style={{ minHeight: 32, borderTop: facts.length ? '.5px solid var(--line-2)' : undefined, color: 'var(--amber-text)' }}>
                      <Icon name="alert" size={15} />{L(`还有 ${placeholders.length} 处占位没填：`, `${placeholders.length} unfilled ${placeholders.length === 1 ? 'placeholder' : 'placeholders'}: `)}{placeholders.slice(0, 2).join(' ')}
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="row" style={{ marginTop: 'auto', gap: 8, fontSize: 11.5, color: 'var(--sec)', alignItems: 'flex-start', padding: '0 4px' }}>
              <Icon name="lock" size={14} style={{ marginTop: 2 }} />{L('AI 只改草稿，不会替你发送。', 'AI only edits the draft. It never sends for you.')}
            </div>
          </aside>
        )}
      </div>
      {menu.node}
    </Sheet>
  )
}

/** 翻译目标语言：传给 AI 的是中文名，菜单按界面语言显示 */
const TRANSLATE_TO: [string, string][] = [['英文', 'English'], ['中文', 'Chinese'], ['意大利语', 'Italian'], ['德语', 'German'], ['法语', 'French'], ['西班牙语', 'Spanish'], ['日语', 'Japanese'], ['韩语', 'Korean'], ['俄语', 'Russian'], ['阿拉伯语', 'Arabic']]

function Recipients({ id, label, list, onChange, extra }: { id?: string; label: string; list: Addr[]; onChange: (v: Addr[]) => void; extra?: React.ReactNode }) {
  const [q, setQ] = useState('')
  const [sug, setSug] = useState<Addr[]>([])
  const [hi, setHi] = useState(0)
  useEffect(() => {
    if (!q.trim()) { setSug([]); return }
    const t = setTimeout(() => api.contacts(q).then((r) => { setSug(r.filter((a) => !list.some((x) => x.email.toLowerCase() === a.email.toLowerCase()))); setHi(0) }).catch(() => {}), 120)
    return () => clearTimeout(t)
  }, [q])
  const add = (a: Addr[]) => { onChange([...list, ...a.filter((x) => !list.some((y) => y.email.toLowerCase() === x.email.toLowerCase()))]); setQ(''); setSug([]) }
  const commit = () => { if (q.trim()) add(parseAddrs(q)) }
  return (
    <div className="c-field" style={{ position: 'relative', flexWrap: 'wrap', paddingTop: 4, paddingBottom: 4 }}>
      <span className="k">{label}</span>
      {list.map((a, i) => (
        <span key={i} className={`chip${validEmail(a.email) ? '' : ' bad'}`} title={a.email}>
          {a.name || a.email}
          <button aria-label={L(`移除 ${a.email}`, `Remove ${a.email}`)} onClick={() => onChange(list.filter((_, j) => j !== i))}><Icon name="x" size={10} /></button>
        </span>
      ))}
      <input id={id} value={q} aria-label={label} style={{ minWidth: 140, height: 32 }}
        onChange={(e) => { const v = e.target.value; if (/[,;，；]$/.test(v)) { add(parseAddrs(v)) } else setQ(v) }}
        onBlur={() => setTimeout(commit, 150)}
        onPaste={(e) => { const t = e.clipboardData.getData('text'); if (/[,;\n]/.test(t)) { e.preventDefault(); add(parseAddrs(t)) } }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && sug.length) { e.preventDefault(); setHi((hi + 1) % sug.length) }
          else if (e.key === 'ArrowUp' && sug.length) { e.preventDefault(); setHi((hi - 1 + sug.length) % sug.length) }
          else if (e.key === 'Enter' || e.key === 'Tab') { if (sug[hi]) { e.preventDefault(); add([sug[hi]]) } else if (q.trim()) { e.preventDefault(); commit() } }
          else if (e.key === 'Backspace' && !q && list.length) onChange(list.slice(0, -1))
        }} />
      {extra && <span style={{ marginLeft: 'auto' }}>{extra}</span>}
      {sug.length > 0 && (
        <div className="menu sq" style={{ position: 'absolute', top: '100%', left: 64, minWidth: 300 }}>
          {sug.map((a, i) => (
            <button key={a.email} onMouseDown={(e) => { e.preventDefault(); add([a]) }} style={i === hi ? { background: 'var(--sel)' } : undefined}>
              <span className="grow truncate">{a.name || a.email}</span><span style={{ fontSize: 12, color: 'var(--sec)' }}>{a.name ? a.email : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Icon } from '../icons'
import { useApp } from '../store'
import { api, errText } from '../lib/api'
import { ACCOUNT_COLORS, ago, fullTime } from '../lib/format'
import { PROVIDERS, canOAuth, guessHosts, methodOf, providerFor, type Provider } from '../lib/providers'
import { Kojoo, Sheet } from '../ui'
import { L } from '../lib/i18n'

/** 用户取消了浏览器登录：后端回的报错，不用显示 */
const isCancel = (t: string) => t === '已取消' || /^cancel/i.test(t)

export function ProviderGlyph({ p }: { p: Provider }) {
  if (p.id === 'icloud') return <span className="g"><Icon name="cloud" size={14} /></span>
  if (p.id === 'imap') return <span className="g"><Icon name="at" size={14} /></span>
  // 等宽字体里 O 像 0，换成正文字体
  if (p.id === 'outlook') return <span className="g" style={{ font: '600 12.5px var(--sans)' }}>O</span>
  if (p.id === 'kojoo') return <span className="g" style={{ font: "italic 400 17px/1 'Instrument Serif', serif", paddingBottom: 2 }}>k</span>
  return <span className="g" style={{ fontSize: p.glyph.length > 2 ? 9.5 : 11 }}>{p.glyph}</span>
}

export function AddAccount() {
  const s = useApp()
  const preset = typeof s.addAccount === 'string' && s.addAccount !== 'pick' ? PROVIDERS.find((p) => p.id === s.addAccount) : undefined
  const [p, setP] = useState<Provider>(preset || PROVIDERS[0])
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [label, setLabel] = useState('')
  // 发件人名字：对方收件箱里显示的名字。默认沿用已有账号的
  const [name, setName] = useState(s.accounts.find((a) => a.displayName)?.displayName ?? '')
  const [color, setColor] = useState(ACCOUNT_COLORS[s.accounts.length % ACCOUNT_COLORS.length])
  const [adv, setAdv] = useState(false)
  const [h, setH] = useState({ imapHost: p.imapHost, imapPort: p.imapPort, smtpHost: p.smtpHost, smtpPort: p.smtpPort, smtpTls: p.smtpTls, username: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // Gmail 也能改用应用专用密码
  const [usePass, setUsePass] = useState(false)
  // 浏览器里正在登录
  const [waiting, setWaiting] = useState(false)
  const oauthOn = canOAuth(p, s.oauth) && !usePass
  const unavailable = !!p.oauth && !canOAuth(p, s.oauth) && p.id === 'outlook'

  useEffect(() => { setH({ imapHost: p.imapHost, imapPort: p.imapPort, smtpHost: p.smtpHost, smtpPort: p.smtpPort, smtpTls: p.smtpTls, username: '' }); setErr(''); setUsePass(false); if (p.id === 'imap') setAdv(true) }, [p.id])
  // 关掉窗口时，浏览器那边的登录也不再等
  useEffect(() => () => { api.oauthCancel().catch(() => {}) }, [])
  // 输入邮箱后自动识别服务商 / 猜服务器
  useEffect(() => {
    const auto = providerFor(email)
    // 不在列表里的（kojoo）任何时候都识别；改成别的地址时退回「其他邮箱」
    if (auto && auto.id !== p.id && (p.id === 'imap' || auto.hidden)) setP(auto)
    else if (!auto && p.hidden) setP(PROVIDERS.find((x) => x.id === 'imap')!)
    if (p.id === 'imap' && email.includes('@')) {
      const g = guessHosts(email)
      setH((x) => ({ ...x, imapHost: x.imapHost && !x.imapHost.startsWith('imap.') ? x.imapHost : g.imap, smtpHost: x.smtpHost && !x.smtpHost.startsWith('smtp.') ? x.smtpHost : g.smtp }))
    }
  }, [email])

  // 正在验证收信发信时不能关（关了后台还在加账号）；浏览器登录中可以关，会顺带取消
  const close = () => { if (busy && !waiting) return; s.set({ addAccount: false }) }
  const done = async () => {
    const first = s.accounts.length === 0
    await s.refreshMeta()
    s.set({ addAccount: false })
    // 第一个账号：顺便提示有教程
    if (first) s.toast(L('已添加，正在下载邮件', 'Added. Downloading your mail…'), { action: { label: L('看教程', 'View guide'), run: () => s.set({ page: 'settings', settingsTab: 'guide' }) }, ttl: 8000 })
    else s.toast(L('已添加，正在下载邮件', 'Added. Downloading your mail…'))
    s.go({ kind: 'all' })
  }
  const oauthSubmit = async () => {
    setErr('')
    if (!name.trim()) { setErr(L('请填写发件人名字', 'Enter a sender name')); return }
    setBusy(true); setWaiting(true)
    try {
      const g = await api.oauthLogin(p.id, email.trim() || undefined)
      setWaiting(false)
      await api.addAccount({
        email: g.email, password: '', provider: p.id, displayName: name.trim(), label: label.trim() || p.name, color,
        imapHost: p.imapHost, imapPort: p.imapPort, smtpHost: p.smtpHost, smtpPort: p.smtpPort, smtpTls: p.smtpTls, saveSent: p.saveSent, oauthTicket: g.ticket,
      })
      await done()
    } catch (e) { const t = errText(e); if (!isCancel(t)) setErr(t) } finally { setBusy(false); setWaiting(false) }
  }
  const submit = async () => {
    if (oauthOn) return oauthSubmit()
    if (unavailable) return
    setErr('')
    if (!name.trim()) { setErr(L('请填写发件人名字', 'Enter a sender name')); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setErr(L('邮箱地址不对', 'That email address doesn\'t look right')); return }
    if (!pass) { setErr(L(`请填写${p.codeLabel}`, `Enter the ${p.codeLabel}`)); return }
    if (!h.imapHost || !h.smtpHost) { setErr(L('请填写收信和发信服务器', 'Enter the incoming and outgoing servers')); setAdv(true); return }
    // 收信只支持直接加密连接（SSL），143 这种明文再升级的端口连不上
    if (h.imapPort === 143) { setErr(L('收信服务器请用 SSL 加密端口（一般是 993），143 端口暂不支持', 'Use the SSL port for the incoming server (usually 993). Port 143 isn\'t supported yet.')); setAdv(true); return }
    setBusy(true)
    try {
      await api.addAccount({
        email: email.trim(), password: pass, provider: p.id, displayName: name.trim(), label: label.trim() || p.name, color,
        username: h.username || undefined, imapHost: h.imapHost.trim(), imapPort: h.imapPort, smtpHost: h.smtpHost.trim(), smtpPort: h.smtpPort, smtpTls: h.smtpTls, saveSent: p.saveSent,
      })
      await done()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }

  const labelColor = (
    <>
    <div>
      <label className="label" htmlFor="a-name">{L('发件人名字', 'Sender name')}</label>
      <input id="a-name" className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder={L('比如 张三 或 Kojoo Trading', 'e.g. Jane Smith or Kojoo Trading')} />
      <div className="hint">{L('对方收到信时看到的名字', 'The name people see when they get your email')}{name && s.accounts.some((a) => a.displayName === name) ? L('（沿用了你其他邮箱的，公司邮箱记得改）', ' (copied from your other account; change it for a work mailbox)') : ''}{L('，之后可以在「设置 → 账号」里改。', '. You can change it later in Settings → Accounts.')}</div>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 16, alignItems: 'end' }}>
      <div><label className="label" htmlFor="a-label">{L('显示名称', 'Display name')}</label><input id="a-label" className="field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={L(`比如 外贸 · ${p.name}`, `e.g. Sales · ${p.name}`)} /></div>
      <div>
        <div className="label" style={{ marginBottom: 9 }}>{L('颜色', 'Color')}</div>
        <div className="row" style={{ gap: 8, height: 26 }}>
          {ACCOUNT_COLORS.map((c) => <button key={c} aria-label={L(`颜色 ${c}`, `Color ${c}`)} onClick={() => setColor(c)} style={{ width: 18, height: 18, border: 0, borderRadius: '50%', padding: 0, background: c, cursor: 'pointer', boxShadow: color === c ? `0 0 0 2px var(--card), 0 0 0 3.5px ${c}` : 'none' }} />)}
        </div>
      </div>
    </div>
    </>
  )

  return (
    <Sheet onClose={close} label={L('添加邮箱账号', 'Add account')} className="">
      <div className="sh-head">
        <div className="grow"><h1>{L('添加邮箱账号', 'Add account')}</h1><p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--sec)' }}>{L('登录凭证只加密保存在这台电脑上。', 'Sign-in details are stored encrypted on this computer only.')}</p></div>
        <button className="tb" aria-label={L('关闭', 'Close')} onClick={close}><Icon name="x" /></button>
      </div>
      <div className="sh-body">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
          {PROVIDERS.filter((x) => !x.hidden).map((x) => (
            <button key={x.id} className={`pv sq${x.id === p.id || (p.hidden && x.id === 'imap') ? ' on' : ''}`} style={{ height: 'auto', flexDirection: 'column', gap: 4, padding: '10px 6px', textAlign: 'center' }} disabled={busy} onClick={() => setP(x)} aria-pressed={x.id === p.id}>
              <ProviderGlyph p={x} />
              <span style={{ fontSize: 12.5 }}>{x.name}</span>
              <span style={{ fontSize: 11, color: 'var(--sec)', fontWeight: 400 }}>{methodOf(x, s.oauth)}</span>
            </button>
          ))}
        </div>

        {oauthOn ? (
          <div className="group sq" style={{ padding: 16, marginTop: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
              <Icon name="lock" style={{ marginTop: 2, flex: 'none' }} />
              <div style={{ fontSize: 13, lineHeight: 1.65 }}>
                <div style={{ fontWeight: 600 }}>{L(`用${p.oauth!.brand}账号登录`, `Sign in with your ${p.oauth!.brand} account`)}</div>
                <div style={{ color: 'var(--sec)' }}>{L(`点「在浏览器中登录」，在${p.oauth!.brand}的页面登录并允许 Kojoo Mail 收发邮件，完成后自动回到这里。密码只在${p.oauth!.brand}的页面上输入，Kojoo Mail 拿不到。`, `Click "Sign in with browser", sign in on ${p.oauth!.brand}'s page and allow Kojoo Mail to send and receive email. You'll come back here automatically. Your password is only entered on ${p.oauth!.brand}'s page; Kojoo Mail never sees it.`)}</div>
                {p.id === 'gmail' && <div style={{ color: 'var(--sec)' }}>{L('国内需要能访问谷歌的网络。谷歌页面如果提示「Google 尚未验证此应用」，点「高级 → 转至 Kojoo Mail」继续即可；不放心也可以点下面的「改用应用专用密码」。', 'You need a network that can reach Google. If Google says "Google hasn\'t verified this app", click Advanced → Go to Kojoo Mail to continue, or use "Use an app password instead" below.')}</div>}
                {p.id === 'outlook' && (
                  <div style={{ marginTop: 6 }}>
                    <span style={{ fontWeight: 600 }}>{L('登录前先打开 IMAP：', 'Turn on IMAP first: ')}</span>
                    <span style={{ color: 'var(--sec)' }}>{L('在 ', 'in ')}</span>
                    <a href="https://outlook.live.com/mail/0/options/mail/forwarding" onClick={(e) => { e.preventDefault(); api.openUrl('https://outlook.live.com/mail/0/options/mail/forwarding') }}>{L('Outlook 网页版', 'Outlook on the web')}</a>
                    <span style={{ color: 'var(--sec)' }}>{L('「设置 → 邮件 → 转发和 IMAP」里打开「允许设备和应用使用 IMAP」并保存，否则收信会被拒绝。公司邮箱由管理员统一设置。', ', go to Settings → Mail → Forwarding and IMAP, turn on "Let devices and apps use IMAP" and save, or receiving mail will be refused. For work accounts, your admin controls this.')}</span>
                  </div>
                )}
              </div>
            </div>
            {labelColor}
          </div>
        ) : unavailable ? (
          <div className="group sq" style={{ padding: 16, marginTop: 18, fontSize: 13, lineHeight: 1.65, color: 'var(--sec)' }}>
            {L('Outlook 只能用微软账号授权登录，这个版本暂时不支持。可以先在 Outlook 网页版收发，或把 Outlook 的信转发到别的邮箱。', 'Outlook only allows sign-in through a Microsoft account, which this build doesn\'t support yet. Use Outlook on the web for now, or forward your Outlook mail to another mailbox.')}
          </div>
        ) : (
        <div className="group sq" style={{ padding: 16, marginTop: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label className="label" htmlFor="a-email">{L('邮箱地址', 'Email address')}</label>
            <input id="a-email" autoCapitalize="off" autoCorrect="off" spellCheck={false} className="field" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={p.domains[0] ? `name@${p.domains[0]}` : 'name@company.com'} autoFocus />
          </div>
          <div>
            <div className="row" style={{ marginBottom: 6 }}>
              <label className="label" htmlFor="a-pass" style={{ margin: 0 }}>{p.codeLabel}</label>
              {p.helpUrl && <button className="btn link sm" style={{ marginLeft: 'auto', height: 18 }} onClick={() => api.openUrl(p.helpUrl!)}>{p.helpLabel ?? L(`如何获取${p.codeLabel}？`, `How do I get an ${p.codeLabel}?`)}</button>}
            </div>
            <input id="a-pass" className="field" type="password" value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
            <div className="hint">{p.help}</div>
          </div>
          {labelColor}
        </div>
        )}

        <div className="row" style={{ marginTop: 10, gap: 16 }}>
        {!oauthOn && !unavailable && <button className="btn link sm" style={{ color: 'var(--ink-2)' }} onClick={() => setAdv(!adv)}>
          <Icon name={adv ? 'down' : 'right'} size={13} />{L('高级设置', 'Advanced')}
          {!adv && <span className="mono" style={{ marginLeft: 8, fontSize: 12, color: 'var(--sec)' }}>{h.imapHost || '—'}:{h.imapPort} · {h.smtpHost || '—'}:{h.smtpPort}</span>}
        </button>}
        {p.id === 'gmail' && canOAuth(p, s.oauth) && (
          <button className="btn link sm" style={{ marginLeft: 'auto', color: 'var(--ink-2)' }} disabled={busy} onClick={() => { setUsePass(!usePass); setErr('') }}>
            {usePass ? L('改用一键登录', 'Use one-click sign-in instead') : L('改用应用专用密码', 'Use an app password instead')}
          </button>
        )}
        </div>
        {adv && !oauthOn && !unavailable && (
          <div className="group sq" style={{ marginTop: 8 }}>
            <div className="gr"><span className="lbl">{L('收信服务器（IMAP）', 'Incoming server (IMAP)')}</span><div className="row" style={{ gap: 6 }}><input className="field inset mono" autoCapitalize="off" autoCorrect="off" spellCheck={false} style={{ width: 200 }} value={h.imapHost} onChange={(e) => setH({ ...h, imapHost: e.target.value })} /><input className="field inset mono" autoCapitalize="off" autoCorrect="off" spellCheck={false} style={{ width: 70 }} value={h.imapPort} onChange={(e) => setH({ ...h, imapPort: Number(e.target.value) || 993 })} /></div></div>
            <div className="gr"><span className="lbl">{L('发信服务器（SMTP）', 'Outgoing server (SMTP)')}</span><div className="row" style={{ gap: 6 }}><input className="field inset mono" autoCapitalize="off" autoCorrect="off" spellCheck={false} style={{ width: 200 }} value={h.smtpHost} onChange={(e) => setH({ ...h, smtpHost: e.target.value })} /><input className="field inset mono" autoCapitalize="off" autoCorrect="off" spellCheck={false} style={{ width: 70 }} value={h.smtpPort} onChange={(e) => { const v = Number(e.target.value) || 465; setH({ ...h, smtpPort: v, smtpTls: v === 465 }) }} /></div></div>
            <div className="gr"><div><div className="lbl">{L('登录用户名', 'Username')}</div><div className="sub">{L('一般就是邮箱地址，少数企业邮箱不一样', 'Usually your email address; a few work mailboxes differ')}</div></div><input className="field inset" autoCapitalize="off" autoCorrect="off" spellCheck={false} style={{ width: 200 }} value={h.username} placeholder={L('同邮箱地址', 'Same as email address')} onChange={(e) => setH({ ...h, username: e.target.value })} /></div>
          </div>
        )}
        {err && <div className="err" style={{ marginTop: 12 }}>{err}</div>}
      </div>
      <div className="sh-foot">
        <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--sec)' }}>{busy ? <><span style={{ color: 'var(--ink)', display: 'inline-flex' }}><Kojoo width={28} stroke={7} /></span>{waiting ? L('正在等浏览器里完成登录…', 'Waiting for you to finish signing in the browser…') : L('正在验证收信和发信…', 'Checking incoming and outgoing mail…')}</> : <><Icon name="lock" size={14} />{L('会先验证收信和发信都能连通', 'We\'ll check that sending and receiving both work first')}</>}</span>
        {/* 浏览器登录中：「取消」只停掉这次登录，不关窗口 */}
        <button className="btn sq" style={{ marginLeft: 'auto' }} disabled={busy && !waiting} onClick={waiting ? () => api.oauthCancel() : close}>{L('取消', 'Cancel')}</button>
        <button className="btn primary sq" disabled={busy || unavailable} onClick={submit}>{oauthOn ? L('在浏览器中登录', 'Sign in with browser') : L('连接', 'Connect')}</button>
      </div>
    </Sheet>
  )
}

export function RepairAccount() {
  const s = useApp()
  const a = s.accounts.find((x) => x.id === s.repairAccount)
  const st = a ? s.status[a.id] : undefined
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [showLog, setShowLog] = useState(false)
  // 应用专用密码登录的 Gmail，也可以在这里改成一键登录
  const [switchOAuth, setSwitchOAuth] = useState(false)
  useEffect(() => () => { api.oauthCancel().catch(() => {}) }, [])
  if (!a) return null
  const p = PROVIDERS.find((x) => x.id === a.provider) || PROVIDERS[PROVIDERS.length - 1]
  const viaOAuth = (a.auth === 'oauth' || switchOAuth) && canOAuth(p, s.oauth)
  const close = () => s.set({ repairAccount: null })
  const auth = st?.errorKind === 'auth' || !st || st.state !== 'offline'
  const submit = async () => {
    if (viaOAuth) {
      setBusy(true); setErr('')
      try {
        const g = await api.oauthLogin(p.id, a.email)
        await api.updateAccount(a.id, { oauthTicket: g.ticket })
        await s.refreshMeta()
        close(); s.toast(L('已重新登录，正在补齐邮件', 'Signed in again. Catching up on mail…'))
      } catch (e) { const t = errText(e); if (!isCancel(t)) setErr(t) } finally { setBusy(false) }
      return
    }
    if (!pass) { setErr(L(`请填写新的${p.codeLabel}`, `Enter the new ${p.codeLabel}`)); return }
    setBusy(true); setErr('')
    try { await api.updateAccount(a.id, { password: pass }); close(); s.toast(L('已重新连接，正在补齐邮件', 'Reconnected. Catching up on mail…')) } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const what = a.auth === 'oauth' ? L('登录授权', 'sign-in authorization') : p.codeLabel
  return (
    <Sheet onClose={close} label={L(`${a.email} 无法同步`, `Can't sync ${a.email}`)}>
      <div className="sh-head" style={{ gap: 14 }}>
        <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--accent-soft)', color: 'var(--accent-text)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><Icon name="alert" size={20} /></div>
        <div className="grow">
          <h1>{st?.state === 'error' || st?.state === 'offline' ? L(`${a.label || a.email} 无法同步`, `Can't sync ${a.label || a.email}`) : a.auth === 'oauth' ? L(`重新登录 ${a.label || a.email}`, `Sign in to ${a.label || a.email} again`) : L(`更换 ${a.label || a.email} 的${p.codeLabel}`, `Change the ${p.codeLabel} for ${a.label || a.email}`)}</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.6, color: 'var(--sec)' }}>
            {st?.errorKind === 'store' ? st.error : st?.state === 'offline' ? L('暂时连不上邮件服务器，网络恢复后会自动重连。', 'Can\'t reach the mail server right now. It will reconnect automatically when the network is back.') : st?.state === 'error' ? L(`邮件服务器拒绝了登录，${what}可能已修改、过期或被撤销。期间收到的邮件不会丢，重新连接后会自动补齐。`, `The mail server refused to sign in. The ${what} may have been changed, expired or revoked. No mail is lost in the meantime; it will catch up once you reconnect.`) : viaOAuth ? L('在浏览器里重新登录同一个账号，验证通过后才会替换。', 'Sign in to the same account again in your browser. It\'s only replaced once verified.') : L('新的密码验证通过后才会替换。', 'The new password is only saved once it\'s verified.')}
          </p>
        </div>
        <button className="tb" aria-label={L('关闭', 'Close')} onClick={close}><Icon name="x" /></button>
      </div>
      <div className="sh-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {st && (st.state === 'error' || st.state === 'offline') && (
          <div className="group sq">
            <div className="gr" style={{ minHeight: 38, fontSize: 12.5 }}><span style={{ color: 'var(--sec)' }}>{L('上次成功同步', 'Last successful sync')}</span><span className="num">{st.lastOk ? L(`${fullTime(st.lastOk)}（${ago(st.lastOk)}）`, `${fullTime(st.lastOk)} (${ago(st.lastOk)})`) : L('还没有成功过', 'Never')}</span></div>
            {st.errorKind === 'auth' && <div className="gr" style={{ minHeight: 38, fontSize: 12.5 }}><span style={{ color: 'var(--sec)' }}>{L('自动重试', 'Auto retry')}</span><span>{st.fails >= 3 ? L('已暂停（连续失败 3 次，避免被服务器封禁）', 'Paused (failed 3 times in a row; stopping so the server doesn\'t block you)') : L(`已失败 ${st.fails} 次，1 分钟后再试`, `Failed ${st.fails} ${st.fails === 1 ? 'time' : 'times'}. Trying again in 1 minute`)}</span></div>}
            <button className="gr" style={{ width: '100%', border: 0, background: 'transparent', fontSize: 12.5, color: 'var(--sec)', cursor: 'pointer' }} aria-expanded={showLog} onClick={() => setShowLog(!showLog)}>
              <Icon name={showLog ? 'down' : 'right'} size={13} />{L('技术细节', 'Technical details')}
            </button>
            {showLog && (
              <div className="mono" style={{ padding: '0 14px 12px 31px', fontSize: 11.5, lineHeight: 1.6, color: 'var(--sec)', userSelect: 'text', wordBreak: 'break-all' }}>
                {a.imapHost}:{a.imapPort}<br />{st.error}
                {st.log.slice(-6).map((l, i) => <div key={i}>{l}</div>)}
              </div>
            )}
          </div>
        )}
        {auth && viaOAuth && (
          <div className="row" style={{ alignItems: 'flex-start', gap: 12, fontSize: 13, lineHeight: 1.65 }}>
            <Icon name="lock" style={{ marginTop: 2, flex: 'none' }} />
            <div style={{ color: 'var(--sec)' }}>{L('点「在浏览器中登录」，用 ', `Click "Sign in with browser", sign in to your ${p.oauth!.brand} account as `)}<span style={{ color: 'var(--ink)' }}>{a.email}</span>{L(`登录${p.oauth!.brand}账号并允许访问，完成后自动回到这里。`, ' and allow access. You\'ll come back here automatically.')}</div>
          </div>
        )}
        {auth && !viaOAuth && a.auth === 'oauth' && <div style={{ fontSize: 13, color: 'var(--sec)' }}>{L(`这个版本没有配置${p.oauth?.brand ?? ''}登录，没法重新授权。`, `This build isn't set up for ${p.oauth?.brand ?? ''} sign-in, so it can't be re-authorized.`)}</div>}
        {auth && !viaOAuth && a.auth !== 'oauth' && (
          <div>
            <div className="row" style={{ marginBottom: 6 }}>
              <label className="label" htmlFor="r-pass" style={{ margin: 0 }}>{L(`新的${p.codeLabel}`, `New ${p.codeLabel}`)}</label>
              {p.helpUrl && <button className="btn link sm" style={{ marginLeft: 'auto', height: 18 }} onClick={() => api.openUrl(p.helpUrl!)}>{L('在哪里找？', 'Where do I find it?')}</button>}
            </div>
            <input id="r-pass" className="field" type="password" value={pass} autoFocus onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder={L(`粘贴新的${p.codeLabel}`, `Paste the new ${p.codeLabel}`)} />
            <div className="hint">{p.help}</div>
            {canOAuth(p, s.oauth) && <button className="btn link sm" style={{ marginTop: 8, color: 'var(--ink-2)' }} onClick={() => { setSwitchOAuth(true); setErr('') }}>{L('改用一键登录', 'Use one-click sign-in instead')}</button>}
          </div>
        )}
        {err && <div className="err">{err}</div>}
      </div>
      <div className="sh-foot">
        {(st?.state === 'offline' || st?.errorKind === 'store') && <button className="btn link sq" onClick={() => { api.retryAccount(a.id); close() }}>{L('立即重试', 'Retry now')}</button>}
        <button className="btn sq" style={{ marginLeft: 'auto' }} onClick={close}>{L('稍后处理', 'Later')}</button>
        {auth && (viaOAuth || a.auth !== 'oauth') && <button className="btn primary sq" disabled={busy} onClick={submit}>{busy ? (viaOAuth ? L('等浏览器里完成登录…', 'Waiting for the browser…') : L('正在验证…', 'Verifying…')) : viaOAuth ? L('在浏览器中登录', 'Sign in with browser') : L('重新连接', 'Reconnect')}</button>}
      </div>
    </Sheet>
  )
}

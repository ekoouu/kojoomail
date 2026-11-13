import { useEffect, useState } from 'react'
import { ask } from '../lib/ask'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Icon } from '../icons'
import { useApp } from '../store'
import { api, errText, FOCUS_CATS, type Account } from '../lib/api'
import { ACCOUNT_COLORS, ago } from '../lib/format'
import { Seg, Switch } from '../ui'
import { GuideContent } from './Guide'
import { Rules } from './Rules'
import { DATA_DIR, IS_MAC, TRAY, VAULT, keyText } from '../lib/platform'
import { L, catLabel } from '../lib/i18n'

// 侧栏分组，和主界面侧栏一样带小标题
const GROUPS: [string, [string, string, string][]][] = [
  [L('基本', 'Basics'), [['general', 'gear', L('通用', 'General')], ['accounts', 'mail', L('账号', 'Accounts')], ['ai', 'sparkle', L('AI 与模型', 'AI & models')]]],
  [L('提醒与操作', 'Alerts & controls'), [['notify', 'bell', L('通知与隐私', 'Notifications & privacy')], ['rules', 'sliders', L('邮件规则', 'Mail rules')], ['keys', 'keyboard', L('快捷键', 'Shortcuts')]]],
  [L('帮助', 'Help'), [['guide', 'doc', L('使用教程', 'Guide')], ['about', 'info', L('关于', 'About')]]],
]

export default function SettingsPage() {
  const s = useApp()
  const tab = s.settingsTab
  return (
    <div className="settings">
      <nav className="set-nav" aria-label={L('设置分类', 'Settings sections')}>
        <div className="row" style={{ height: 30, marginBottom: 12 }}>
          <button className="tb" aria-label={L('返回邮件', 'Back to mail')} onClick={() => s.set({ page: 'mail' })}><Icon name="left" /></button>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{L('设置', 'Settings')}</span>
        </div>
        {GROUPS.map(([title, tabs], gi) => (
          <div key={title} role="group" aria-label={title}>
            <div className={`h${gi ? ' gap' : ''}`}>{title}</div>
            {tabs.map(([k, icon, label]) => (
              <button key={k} className={`nav sq${tab === k ? ' on' : ''}`} onClick={() => s.set({ settingsTab: k })}><Icon name={icon} />{label}</button>
            ))}
          </div>
        ))}
        <div style={{ marginTop: 'auto', padding: '8px 10px', fontSize: 11, color: 'var(--ter)' }}>{L('版本', 'Version')} {s.version}</div>
      </nav>
      <main className="set-main">
        <div className="inner">
          {tab === 'general' && <General />}
          {tab === 'accounts' && <Accounts />}
          {tab === 'ai' && <Ai />}
          {tab === 'notify' && <NotifyPrivacy />}
          {tab === 'rules' && <Rules />}
          {tab === 'keys' && <Keys />}
          {tab === 'guide' && <><Head title={L('使用教程', 'Guide')} lead={L('五分钟了解 Kojoo Mail 怎么用。', 'Learn Kojoo Mail in five minutes.')} /><GuideContent /></>}
          {tab === 'about' && <About />}
        </div>
      </main>
    </div>
  )
}

const Head = ({ title, lead }: { title: string; lead: string }) => <div><h1>{title}</h1><p className="lead">{lead}</p></div>

function General() {
  const s = useApp()
  const st = s.settings!
  const save = s.saveSettings
  const [pm, setPm] = useState(st.proxyMode ?? 'system')
  const [pa, setPa] = useState(st.proxyAddr ?? '')
  const commit = () => {
    const a = pa.trim()
    if (a && (st.proxyMode !== 'custom' || a !== st.proxyAddr)) save({ proxyMode: 'custom', proxyAddr: a })
  }
  return (
    <>
      <Head title={L('通用', 'General')} lead={L('语言、外观、字号和启动方式。', 'Language, appearance, text size and startup.')} />
      <section>
        <h2 className="gh">{L('语言', 'Language')}</h2>
        <div className="group sq">
          <div className="gr" style={{ minHeight: 52 }}><div><div className="lbl">{L('界面语言', 'Interface language')}</div><div className="sub">{L('AI 写的摘要、要点和简报也用这个语言（已有的批注不重写）；建议回复跟着来信的语言', 'AI summaries, key facts and the digest use this language too (existing notes stay as they are); suggested replies follow the sender')}</div></div>
            <Seg small value={st.language ?? 'auto'} onChange={(v) => save({ language: v })} options={[['auto', '跟随系统 / System'], ['zh', '中文'], ['en', 'English']]} />
          </div>
        </div>
      </section>
      <section>
        <h2 className="gh">{L('外观', 'Appearance')}</h2>
        <div className="group sq" style={{ padding: '16px 14px 14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14 }}>
            {([['light', L('浅色', 'Light')], ['dark', L('深色', 'Dark')], ['system', L('跟随系统', 'System')]] as const).map(([k, label]) => (
              <button key={k} onClick={() => save({ theme: k })} style={{ border: 0, background: 'transparent', padding: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, cursor: 'pointer', color: 'var(--ink)', fontSize: 12.5, fontWeight: st.theme === k ? 600 : 400 }}>
                <span className="sq" style={{
                  width: '100%', height: 64, borderRadius: 8, display: 'block',
                  background: k === 'light' ? '#F7F7F5' : k === 'dark' ? '#14181E' : 'linear-gradient(105deg, #F7F7F5 0 50%, #14181E 50% 100%)',
                  boxShadow: st.theme === k ? '0 0 0 2px var(--navy), 0 0 0 4.5px var(--navy-soft)' : '0 0 0 .5px var(--line)',
                }} />
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section>
        <h2 className="gh">{L('文字与布局', 'Text & layout')}</h2>
        <div className="group sq">
          <div style={{ padding: '12px 14px 14px' }}>
            <div className="row"><label htmlFor="fs" className="lbl" style={{ fontSize: 13.5 }}>{L('正文字号', 'Body text size')}</label><span className="num" style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--sec)' }}>{st.fontSize}{st.fontSize === 13 ? L(' · 标准', ' · Default') : ''}</span></div>
            <div className="row" style={{ marginTop: 10, gap: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--sec)' }}>A</span>
              <input id="fs" type="range" min={12} max={16} step={0.5} value={st.fontSize} onChange={(e) => save({ fontSize: Number(e.target.value) })} style={{ flex: 1, accentColor: 'var(--navy)' }} />
              <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--sec)' }}>A</span>
            </div>
            <div className="sq" style={{ marginTop: 12, padding: '12px 14px', borderRadius: 8, background: 'var(--sunken)', boxShadow: 'inset 0 0 0 .5px var(--line-2)' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--sec)', marginBottom: 4 }}>{L('预览', 'Preview')}</div>
              <div style={{ fontSize: st.fontSize, lineHeight: 1.6, color: 'var(--ink-2)' }}>Thank you for your inquiry. We can supply 2,000 sets with FSC certification. 感谢询价，我们可以提供 2,000 套带 FSC 认证的竹餐具。</div>
            </div>
            <div className="hint">{L('影响读信和写信的正文。', 'Applies to the body of emails you read and write. ')}{IS_MAC ? '' : L('要整体放大界面，用 Ctrl + 加号。', 'To zoom the whole interface, press Ctrl + plus.')}</div>
          </div>
          <div className="gr"><span className="lbl">{L('信息密度', 'Density')}</span><Seg small value={st.density} onChange={(v) => save({ density: v })} options={[['compact', L('紧凑', 'Compact')], ['standard', L('标准', 'Default')], ['cozy', L('宽松', 'Comfortable')]]} /></div>
          <div className="gr"><div><div className="lbl">{L('邮件标题用宋体', 'Serif email subjects')}</div><div className="sub">{L('读信时的标题更有阅读感', 'A more bookish look for subjects when reading')}</div></div><Switch label={L('邮件标题用宋体', 'Serif email subjects')} on={st.serifTitles} onChange={(v) => save({ serifTitles: v })} /></div>
          <div className="gr"><div><div className="lbl">{L('按会话显示', 'Conversation view')}</div><div className="sub">{L('同一来回的邮件在列表里合成一行，点开按时间看整串；回复、删除等仍只针对单封', 'Replies in the same conversation share one row in the list; open it to read the whole exchange in order. Reply, delete and other actions still apply to one email at a time')}</div></div><Switch label={L('按会话显示', 'Conversation view')} on={!!st.conversationView} onChange={(v) => save({ conversationView: v })} /></div>
        </div>
      </section>
      <section>
        <h2 className="gh">{L('启动与默认', 'Startup & defaults')}</h2>
        <div className="group sq">
          <div className="gr"><div><div className="lbl">{L('开机自动启动', 'Start at login')}</div><div className="sub">{L(`启动后在${TRAY}里收信，不弹窗口`, `Receives mail in the ${TRAY} without opening a window`)}</div></div><Switch label={L('开机自动启动', 'Start at login')} on={st.autostart} onChange={(v) => save({ autostart: v })} /></div>
          <div className="gr"><div><div className="lbl">{L(`关闭窗口时缩到${TRAY}`, `Keep running in the ${TRAY} when closed`)}</div><div className="sub">{L('继续收新邮件；要彻底退出，', 'Keeps receiving new mail. To quit completely, ')}{IS_MAC ? L('按 ⌘Q', 'press ⌘Q') : L('右键托盘图标选「退出」', 'right-click the tray icon and choose Quit')}</div></div><Switch label={L('关闭窗口时缩到托盘', `Keep running in the ${TRAY} when closed`)} on={st.closeToTray} onChange={(v) => save({ closeToTray: v })} /></div>
          {s.accounts.length > 1 && (
            <div className="gr"><span className="lbl">{L('默认发件账号', 'Default sending account')}</span>
              <select className="field" style={{ width: 'auto', height: 28, fontSize: 12.5 }} value={st.defaultAccount ?? s.accounts[0]?.id} onChange={(e) => save({ defaultAccount: Number(e.target.value) })}>
                {s.accounts.map((a) => <option key={a.id} value={a.id}>{a.label ? `${a.label} · ${a.email}` : a.email}</option>)}
              </select>
            </div>
          )}
        </div>
      </section>
      <section>
        <h2 className="gh">{L('网络', 'Network')}</h2>
        <div className="group sq">
          <div className="gr"><div><div className="lbl">{L('代理', 'Proxy')}</div><div className="sub">{L('收信和发信走哪条路；国内用 Gmail 需要代理。已连上的账号下次重新连接时生效', 'How mail connections are made; Gmail in mainland China needs a proxy. Accounts already connected pick this up the next time they reconnect')}</div></div>
            <Seg small value={pm} options={[['system', L('跟随系统', 'System')], ['off', L('不用代理', 'None')], ['custom', L('自定义', 'Custom')]]} onChange={(v) => {
              if (v === 'custom') {
                setPm('custom')
                if (pa.trim()) save({ proxyMode: 'custom', proxyAddr: pa.trim() })
              } else {
                setPm(v)
                save({ proxyMode: v })
              }
            }} />
          </div>
          {pm === 'custom' && (
            <div className="gr"><div><div className="lbl">{L('代理地址', 'Proxy address')}</div><div className="sub">{L('HTTP 代理的 主机:端口，比如 Clash 的 127.0.0.1:7890；不支持 SOCKS。代理连不上时会直接提示，不会自动改成直连', 'host:port of an HTTP proxy, e.g. 127.0.0.1:7890 for Clash; SOCKS is not supported. If the proxy is unreachable you get an error instead of a silent direct connection')}</div></div>
              <input className="field" style={{ width: 190, height: 28, fontSize: 12.5 }} placeholder="127.0.0.1:7890" spellCheck={false} aria-label={L('代理地址', 'Proxy address')} value={pa} onChange={(e) => setPa(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
            </div>
          )}
        </div>
      </section>
    </>
  )
}

function Accounts() {
  const s = useApp()
  return (
    <>
      <Head title={L('账号', 'Accounts')} lead={L('每个账号的名称、颜色、签名和登录密码。', 'Name, color, signature and sign-in for each account.')} />
      {s.accounts.map((a) => <AccountCard key={a.id} a={a} />)}
      <div><button className="btn primary sq" onClick={() => s.set({ addAccount: 'pick' })}><Icon name="plus" size={15} />{L('添加账号', 'Add account')}</button></div>
    </>
  )
}

function AccountCard({ a }: { a: Account }) {
  const s = useApp()
  const st = s.status[a.id]
  const [label, setLabel] = useState(a.label)
  const [name, setName] = useState(a.displayName)
  const [sig, setSig] = useState(a.signature)
  // 常用分类：本地先变（连点几个不会互相覆盖），保存后以后端为准
  const [focus, setFocus] = useState(a.focus)
  useEffect(() => setFocus(a.focus), [a.focus.join('|')])
  const save = async (p: Parameters<typeof api.updateAccount>[1]) => { try { await api.updateAccount(a.id, p); s.refreshMeta() } catch (e) { s.toast(errText(e), { kind: 'err' }) } }
  const state = !st ? L('等待连接', 'Waiting to connect') : st.state === 'idle' ? L(`已同步 · ${st.lastOk ? ago(st.lastOk) : ''}`, `Synced · ${st.lastOk ? ago(st.lastOk) : ''}`) : st.state === 'syncing' ? L('正在同步', 'Syncing') : st.state === 'connecting' ? L('正在连接', 'Connecting') : st.state === 'error' ? st.error : L(`离线：${st.error}`, `Offline: ${st.error}`)
  return (
    <section>
      <h2 className="gh row" style={{ gap: 6 }}><span className="dot" style={{ background: a.color }} />{a.email}</h2>
      <div className="group sq">
        <div className="gr"><span className="lbl">{L('状态', 'Status')}</span><span style={{ fontSize: 12.5, color: st?.state === 'error' ? 'var(--accent-text)' : 'var(--sec)', maxWidth: 420, textAlign: 'right' }} className="truncate">{state}</span>
          {st?.state === 'error' && <button className="btn sm sq" onClick={() => s.set({ repairAccount: a.id })}>{L('修复', 'Fix')}</button>}
        </div>
        <div className="gr"><span className="lbl">{L('显示名称', 'Display name')}</span><input className="field inset" style={{ width: 240, textAlign: 'right' }} value={label} placeholder={L('比如 外贸 · Gmail', 'e.g. Sales · Gmail')} onChange={(e) => setLabel(e.target.value)} onBlur={() => label !== a.label && save({ label })} /></div>
        <div className="gr"><span className="lbl">{L('发件人名字', 'Sender name')}</span><input className="field inset" style={{ width: 240, textAlign: 'right' }} value={name} placeholder={L('收件人看到的名字', 'The name recipients see')} onChange={(e) => setName(e.target.value)} onBlur={() => name !== a.displayName && save({ displayName: name })} /></div>
        <div className="gr"><span className="lbl">{L('颜色', 'Color')}</span>
          <div className="row" style={{ gap: 8 }}>
            {ACCOUNT_COLORS.map((c) => <button key={c} aria-label={L(`颜色 ${c}`, `Color ${c}`)} onClick={() => save({ color: c })} style={{ width: 18, height: 18, borderRadius: '50%', border: 0, padding: 0, background: c, cursor: 'pointer', boxShadow: a.color === c ? `0 0 0 2px var(--card), 0 0 0 3.5px ${c}` : 'none' }} />)}
          </div>
        </div>
        <div style={{ padding: '10px 14px 12px', borderTop: '.5px solid var(--line-2)' }}>
          <div className="lbl" style={{ marginBottom: 6 }}>{L('签名', 'Signature')}</div>
          <textarea className="field" rows={3} style={{ height: 'auto', padding: '8px 12px', resize: 'vertical', lineHeight: 1.5 }} value={sig} onChange={(e) => setSig(e.target.value)} onBlur={() => sig !== a.signature && save({ signature: sig })} placeholder={L('写新邮件时自动加在末尾', 'Added to the end of new emails')} />
        </div>
        <div className="gr" style={{ alignItems: 'flex-start', paddingTop: 10, paddingBottom: 10 }}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}><div className="lbl">{L('常用分类', 'Category tabs')}</div><div className="sub">{L('邮件列表上方的筛选页签。分类由 AI 判断；没配 AI 时只能自动认出「通知」「订阅」', 'Filter tabs above the mail list. Categories come from AI; without AI only Notifications and Newsletters are detected')}</div></div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', flex: 'none', maxWidth: 380 }}>
            {FOCUS_CATS.map((c) => {
              const on = focus.includes(c)
              return <button key={c} className={`btn sm sq${on ? ' primary' : ''}`} aria-pressed={on} onClick={() => { const next = on ? focus.filter((x) => x !== c) : [...focus, c]; setFocus(next); save({ focus: next }) }}>{catLabel(c)}</button>
            })}
          </div>
        </div>
        <div className="gr" style={{ alignItems: 'flex-start', paddingTop: 10, paddingBottom: 10 }}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}><div className="lbl">{L('AI 处理', 'AI processing')}</div><div className="sub">{!a.aiAllowed ? L('这个账号的邮件不发给 AI，只用本地规则认出通知和订阅', 'Mail from this account is never sent to AI; local rules still detect notifications and newsletters') : a.aiLevel === 'classify' ? L('只判断类别和轻重，不写摘要、要点和回复，省用量；需要时在邮件里点「完整分析」', 'Only category and priority, no summary, facts or reply, to save usage. Click Full analysis on an email when needed') : L('每封新邮件写摘要、要点、待办和建议回复', 'Summary, key facts, to-dos and a suggested reply for every new email')}</div></div>
          <Seg small value={!a.aiAllowed ? 'off' : a.aiLevel} onChange={(v) => save(v === 'off' ? { aiAllowed: false } : { aiAllowed: true, aiLevel: v as 'full' | 'classify' })} options={[['full', L('完整', 'Full')], ['classify', L('只分类', 'Classify only')], ['off', L('不用 AI', 'Off')]]} />
        </div>
        <div className="gr"><div><div className="lbl">{L('服务器', 'Servers')}</div><div className="sub mono">{a.imapHost}:{a.imapPort} · {a.smtpHost}:{a.smtpPort}</div></div>
          <button className="btn sm sq" onClick={() => s.set({ repairAccount: a.id })}>{a.auth === 'oauth' ? L('重新登录', 'Sign in again') : L('更换密码', 'Change password')}</button>
        </div>
        <div className="gr"><span className="lbl" style={{ color: 'var(--accent-text)' }}>{L('删除这个账号', 'Remove this account')}</span>
          <button className="btn sm sq danger" onClick={async () => {
            if (!await ask(L(`从 Kojoo Mail 里删除 ${a.email}？\n只删除这台电脑上的缓存，服务器上的邮件不受影响。`, `Remove ${a.email} from Kojoo Mail?\nOnly the copy on this computer is removed; mail on the server isn't affected.`))) return
            try { await api.removeAccount(a.id); await s.refreshMeta(); s.go({ kind: 'all' }) } catch (e) { s.toast(errText(e), { kind: 'err' }) }
          }}>{L('删除', 'Remove')}</button>
        </div>
      </div>
    </section>
  )
}

// 常用的 OpenAI 兼容服务。模型名各家常改：这里只是建议值，保存密钥后输入框会列出这家实际提供的模型
const AI_PRESETS: { id: string; name: string; base: string; models: [string, string, string]; keyUrl?: string; note: string }[] = [
  { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1', models: ['deepseek-v4-flash', 'deepseek-v4-pro', ''], keyUrl: 'https://platform.deepseek.com/api_keys', note: L('国内直连，按用量付费，价格低，日常分析够用', 'Pay as you go, low cost; plenty for everyday analysis') },
  { id: 'qwen', name: L('通义千问（阿里云百炼）', 'Qwen (Alibaba Cloud Model Studio)'), base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-flash', 'qwen-plus', ''], keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key', note: L('国内直连，新账号有免费额度', 'Works in mainland China; new accounts get free quota') },
  { id: 'kimi', name: L('Kimi（月之暗面）', 'Kimi (Moonshot AI)'), base: 'https://api.moonshot.cn/v1', models: ['', '', ''], keyUrl: 'https://platform.moonshot.cn/console/api-keys', note: L('国内直连；保存密钥后在下面「模型分工」里选模型', 'Works in mainland China; after saving the key, choose models under Model roles below') },
  { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', models: ['gpt-4.1-mini', 'gpt-4.1', ''], keyUrl: 'https://platform.openai.com/api-keys', note: L('国内需要系统代理才能连上', 'Needs a system proxy in mainland China') },
  { id: 'newapi', name: L('New API / One API 网关', 'New API / One API gateway'), base: '', models: ['', '', ''], note: L('自建或中转站的 New API：填站点地址（会自动补 /v1），令牌在站点「令牌」页创建；保存后在下面选模型', 'Self-hosted or relay New API: enter the site address (/v1 is added automatically), create a token on its Tokens page, then pick models below') },
  { id: 'custom', name: L('其他（OpenAI 兼容接口）', 'Other (OpenAI-compatible)'), base: '', models: ['', '', ''], note: L('填服务商给的接口地址（通常以 /v1 结尾）和模型名', "Enter the provider's API address (usually ending in /v1) and model names") },
]
const CUSTOM = AI_PRESETS[AI_PRESETS.length - 1]
// 连接测试结果的前缀：显示颜色按它判断
const TEST_OK = L('已连接', 'Connected')
const TEST_FAIL = L('失败', 'Failed')

/** AI 页右侧控件统一宽度：选择框、地址、密钥、模型名上下对齐 */
const CTRL = 320
// 窄窗口时一起缩（盖掉 .field.inset 默认的 max-width: 46%，否则输入框和选择框宽度不一样）
const COL = { width: CTRL, maxWidth: '50%', flex: 'none' } as const

const hostOf = (u: string) => { try { return new URL(u).host } catch { return u } }
// New API 的 OpenAI 兼容接口在 /v1 下；用户常只填站点首页地址
const withV1 = (u: string) => { try { const x = new URL(u); return x.pathname === '/' || x.pathname === '' ? `${x.origin}/v1` : u.replace(/\/+$/, '') } catch { return u } }

function Ai() {
  const s = useApp()
  const st = s.settings!
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [show, setShow] = useState(false)
  const [test, setTest] = useState<string>('')
  const [base, setBase] = useState(st.aiBase)
  const [models, setModels] = useState({ aiModel: st.aiModel, aiModelFine: st.aiModelFine, aiModelBackup: st.aiModelBackup })
  const [custom, setCustom] = useState(st.aiCustom ?? '')
  const [choices, setChoices] = useState<string[]>([])
  // 以存下来的选择为准；早期没存选择的按地址猜
  const preset = AI_PRESETS.find((p) => p.id === st.aiProvider) ?? AI_PRESETS.find((p) => p.base && p.base === st.aiBase) ?? (st.aiBase ? CUSTOM : undefined)
  const loadChoices = () => api.aiModels().then(setChoices).catch(() => setChoices([]))
  useEffect(() => { api.hasAiKey().then((k) => { setHasKey(k); if (k) loadChoices() }) }, [])
  // 地址、模型、密钥齐了才算配好（和后端 ai::configured 一致）
  const recheck = (k: boolean, b: string, m: string) => s.set({ aiConfigured: k && !!b.trim() && !!m.trim() })
  const runTest = async () => {
    setTest(L('测试中…', 'Testing…'))
    try { const r = await api.aiTest(); setTest(`${TEST_OK} · ${r.model} · ${r.ms} ms`) } catch (e) { setTest(L(`失败：${errText(e)}`, `Failed: ${errText(e)}`)) }
  }
  const pick = async (id: string) => {
    const p = AI_PRESETS.find((x) => x.id === id)!
    if (p.id === preset?.id) return
    // 换服务商：旧密钥是上一家的，不能发给新的一家
    if (hasKey && !await ask(L(`换成 ${p.name}？之前保存的密钥是上一家服务商的，会一并清除，需要填这家的新密钥。`, `Switch to ${p.name}? The saved key belongs to the previous provider and will be removed; you'll need a key from this one.`))) return
    if (hasKey) { await api.setAiKey(''); setHasKey(false); setChoices([]) }
    const m = { aiModel: p.models[0], aiModelFine: p.models[1], aiModelBackup: p.models[2] }
    setBase(p.base); setModels(m); setTest('')
    await s.saveSettings({ aiProvider: p.id, aiBase: p.base, ...m })
    recheck(false, p.base, m.aiModel)
  }
  const saveKey = async () => {
    if (!base.trim()) { s.toast(L('先填接口地址', 'Enter the API address first'), { kind: 'err' }); return }
    if (!hasKey) {
      const n = s.accounts.filter((a) => a.aiAllowed).length
      const auto = st.aiAuto && st.aiScope !== 'important'
      const scope = auto ? L(`新到的邮件（${st.aiScope === 'all' ? '全部' : '跳过通知和广告'}）会自动`, `new mail (${st.aiScope === 'all' ? 'all of it' : 'skipping notifications and ads'}) is automatically sent`) : L('你手动点「让 AI 分析」、起草回复时会', 'when you click Analyze with AI or draft a reply, the email is sent')
      const ok = await ask(L(`保存后 AI 开始工作：\n\n· ${scope}把发件人、主题和正文发到 ${hostOf(base)}，生成摘要、分类和待办\n· 涉及 ${n} 个邮箱，每天最多 ${st.aiDailyLimit} 封；可在本页「隐私与安全」里按邮箱关闭\n· 费用按这家服务的价格从你的账户扣，Kojoo Mail 不经手\n\n确定保存吗？`, `AI starts working once you save:\n\n· The sender, subject and body of ${scope} to ${hostOf(base)} to create summaries, categories and to-dos\n· Covers ${n} mailbox${n === 1 ? '' : 'es'}, up to ${st.aiDailyLimit} emails a day; turn it off per mailbox under Privacy & security on this page\n· Usage is billed to your account at this provider's prices; Kojoo Mail never handles payment\n\nSave?`))
      if (!ok) return
    }
    try {
      const ok = await api.setAiKey(key)
      setKey(''); setHasKey(true); s.set({ aiConfigured: ok }); s.toast(L('密钥已保存', 'Key saved')); loadChoices(); runTest()
    } catch (e) { s.toast(L(`密钥没保存上：${errText(e)}`, `Couldn't save the key: ${errText(e)}`), { kind: 'err' }) }
  }
  // 改了接口地址（换了主机）：旧密钥不能发给新地址，先问再清掉
  const saveBase = async () => {
    const b = preset?.id === 'newapi' ? withV1(base.trim()) : base.trim()
    setBase(b)
    if (b === st.aiBase) return
    if (hasKey && hostOf(b) !== hostOf(st.aiBase)) {
      if (!await ask(L(`接口地址换成了 ${hostOf(b) || '空'}，原来的密钥是上一个地址的，会一并清除，需要重新填。继续吗？`, `The API address changed to ${hostOf(b) || '(empty)'}. The saved key belongs to the old address and will be removed; you'll need to enter it again. Continue?`))) { setBase(st.aiBase); return }
      await api.setAiKey(''); setHasKey(false); setChoices([]); setTest('')
    }
    await s.saveSettings({ aiBase: b })
    recheck(hasKey === true && hostOf(b) === hostOf(st.aiBase), b, models.aiModel)
  }
  return (
    <>
      <Head title={L('AI 与模型', 'AI & models')} lead={L('用你自己的密钥，接你选的模型服务。密钥只加密保存在这台电脑上；不填就不用 AI，只按本地规则分类。', 'Use your own key with the model service you choose. The key is stored encrypted on this computer only. Without one, AI is off and mail is sorted by local rules.')} />
      <section>
        <h2 className="gh">{L('模型服务', 'Model service')}</h2>
        <div className="group sq">
          <div className="gr" style={{ minHeight: 52 }}>
            <div>
              <label className="lbl" htmlFor="ai-pv">{L('服务商', 'Provider')}</label>
              {preset && <div className="sub">{preset.note}{preset.keyUrl && <> · <button className="btn link sm" style={{ height: 'auto', padding: 0, fontSize: 'inherit', verticalAlign: 'baseline', color: 'var(--navy)' }} onClick={() => api.openUrl(preset.keyUrl!)}>{L('获取密钥 ↗', 'Get a key ↗')}</button></>}</div>}
            </div>
            <select id="ai-pv" className="field" style={{ ...COL, height: 28, fontSize: 12.5 }} disabled={hasKey === null} value={preset?.id ?? ''} onChange={(e) => pick(e.target.value)}>
              {!preset && <option value="" disabled>{L('请选择', 'Choose…')}</option>}
              {AI_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {preset && (
            <div className="gr"><label className="lbl" htmlFor="ai-base">{L('接口地址', 'API address')}</label>
              <input id="ai-base" className="field inset mono" style={{ ...COL }} placeholder={preset.id === 'newapi' ? L('https://你的站点域名', 'https://your-site.example') : 'https://…/v1'} value={base} onChange={(e) => setBase(e.target.value)} onBlur={saveBase} />
            </div>
          )}
          {preset && (
            <div className="gr" style={{ minHeight: 52 }}>
              <div><label className="lbl" htmlFor="ai-key">{L('API 密钥', 'API key')}</label><div className="sub row" style={{ gap: 4 }}><Icon name="lock" size={12} />{hasKey ? L('已用系统加密保存在本机', 'Stored encrypted on this computer') : L('还没填', 'Not set')}</div></div>
              <div className="row" style={{ gap: 6, ...COL }}>
                {/* 显示 / 隐藏按钮放在输入框里，整组和上下的输入框一样宽 */}
                <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                  <input id="ai-key" type={show ? 'text' : 'password'} className="field inset mono" style={{ width: '100%', maxWidth: 'none', paddingRight: 30 }} placeholder={hasKey ? L('已保存，输入新的可替换', 'Saved; type a new one to replace') : 'sk-…'} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && key.trim() && saveKey()} />
                  <button className="tb" style={{ position: 'absolute', right: 2, top: 2, width: 24, height: 24 }} aria-label={show ? L('隐藏', 'Hide') : L('显示', 'Show')} onClick={() => setShow(!show)}><Icon name="eye" size={15} /></button>
                </div>
                <button className="btn sm sq" disabled={!key.trim()} onClick={saveKey}>{L('保存', 'Save')}</button>
                {hasKey && <button className="btn sm sq" onClick={async () => { if (!await ask(L('清除密钥？清除后不再调用 AI，只按本地规则分类。', 'Remove the key? AI will stop and mail will be sorted by local rules only.'))) return; await api.setAiKey(''); setHasKey(false); setChoices([]); setTest(''); recheck(false, base, models.aiModel) }}>{L('清除', 'Remove')}</button>}
              </div>
            </div>
          )}
          {preset && (
            <div className="gr">
              <span className="dot" style={{ background: test.startsWith(TEST_OK) ? 'var(--green)' : test.startsWith(TEST_FAIL) ? 'var(--accent)' : 'var(--ter)' }} />
              <span style={{ fontSize: 12.5, color: test.startsWith(TEST_FAIL) ? 'var(--accent-text)' : 'var(--sec)' }} className="grow truncate" title={test}>{test || (s.aiConfigured ? L('已配置', 'Configured') : L('未配置', 'Not configured'))}</span>
              <button className="btn sm sq" disabled={!hasKey} onClick={runTest}>{L('测试连接', 'Test connection')}</button>
            </div>
          )}
        </div>
      </section>
      <section>
        <h2 className="gh">{L('模型分工', 'Model roles')}</h2>
        <datalist id="ai-model-list">{choices.map((m) => <option key={m} value={m} />)}</datalist>
        <div className="group sq">
          {([['aiModel', L('日常分析', 'Everyday'), L('每封新邮件的摘要、分类、待办', 'Summary, category and to-dos for each new email')], ['aiModelFine', L('精细处理', 'Careful'), L('起草回复、点「重新生成」时；空着就用日常分析的', 'Drafting replies and Regenerate; uses the everyday model if empty')], ['aiModelBackup', L('备用', 'Backup'), L('上面的模型连不上时自动切换，可以空着', 'Used automatically when the models above are unreachable; optional')]] as const).map(([k, label, sub]) => (
            <div className="gr" key={k} style={{ minHeight: 52 }}><div><div className="lbl">{label}</div><div className="sub">{sub}</div></div>
              <input className="field inset mono" list="ai-model-list" style={{ ...COL }} placeholder={choices.length ? L('点击选择或输入', 'Pick or type') : L('模型名', 'Model name')} value={models[k]} onChange={(e) => setModels({ ...models, [k]: e.target.value })} onBlur={() => { if (models[k] !== st[k]) { s.saveSettings({ [k]: models[k].trim() }); if (k === 'aiModel') recheck(!!hasKey, base, models.aiModel) } }} />
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2 className="gh">{L('自动分析', 'Automatic analysis')}</h2>
        <div className="group sq">
          {/* 早期的「分析范围 → 不自动分析」（important）和开关是一回事：统一看成关 */}
          <div className="gr"><div><div className="lbl">{L('新邮件到达时自动分析', 'Analyze new mail automatically')}</div>{!(st.aiAuto && st.aiScope !== 'important') && <div className="sub">{L('关着时只在你点「让 AI 分析」、起草回复时调用 AI', 'When off, AI runs only when you click Analyze with AI or draft a reply')}</div>}</div>
            <Switch label={L('自动分析', 'Automatic analysis')} on={st.aiAuto && st.aiScope !== 'important'} onChange={(v) => s.saveSettings({ aiAuto: v, aiScope: v && st.aiScope === 'important' ? 'skip_bulk' : st.aiScope })} />
          </div>
          {st.aiAuto && st.aiScope !== 'important' && (
            <div className="gr"><span className="lbl">{L('分析范围', 'What to analyze')}</span><Seg small value={st.aiScope} onChange={(v) => s.saveSettings({ aiScope: v })} options={[['all', L('全部', 'Everything')], ['skip_bulk', L('跳过通知和广告', 'Skip notifications & ads')]]} /></div>
          )}
          <div className="gr"><span className="lbl">{L('每日上限', 'Daily limit')}</span>
            <div className="row" style={{ gap: 8, ...COL }}>
              <input type="number" className="field inset num" style={{ width: 90, textAlign: 'right' }} min={0} max={5000} value={st.aiDailyLimit} onChange={(e) => s.saveSettings({ aiDailyLimit: Number(e.target.value) || 0 })} />
              <span style={{ fontSize: 12.5, color: 'var(--sec)' }}>{L(`封 · 今天已用 ${s.aiUsedToday}`, `emails · ${s.aiUsedToday} used today`)}</span>
            </div>
          </div>
        </div>
      </section>
      <section>
        <h2 className="gh">{L('自定义要求', 'Custom instructions')}</h2>
        <div className="group sq">
          <div style={{ padding: '10px 14px 12px' }}>
            <div className="sub" style={{ marginBottom: 8 }}>{L('写下你的偏好，比如回复的语气、称呼习惯、更关注哪类信息。AI 写批注、起草回复和跟进邮件时会参考；空着就和原来一样。对之后分析的邮件生效，已有批注点「重新生成」才会更新。', 'Describe your preferences, such as reply tone, how to address people, or what to pay attention to. AI uses them when writing notes, drafting replies and follow-ups; leave empty to keep the default behavior. Applies to mail analyzed from now on; click Regenerate to update existing notes.')}</div>
            <textarea className="field" rows={4} maxLength={500} aria-label={L('自定义要求', 'Custom instructions')} style={{ height: 'auto', padding: '8px 12px', resize: 'vertical', lineHeight: 1.5, width: '100%' }} value={custom} onChange={(e) => setCustom(e.target.value)} onBlur={() => { if (custom.trim() !== (st.aiCustom ?? '')) s.saveSettings({ aiCustom: custom.trim() }) }} placeholder={L('例如：回复尽量简短，称呼对方用「您」；摘要里把金额和截止日期写在最前面', 'Example: keep replies short and polite; put amounts and deadlines first in the summary')} />
            <div className="sub" style={{ marginTop: 6, textAlign: 'right' }}>{custom.length} / 500</div>
          </div>
        </div>
      </section>
      <section>
        <h2 className="gh">{L('隐私与安全', 'Privacy & security')}</h2>
        <div className="group sq">
          {s.accounts.map((a) => (
            <div className="gr" key={a.id}>
              <span className="dot" style={{ background: a.color }} />
              <div className="grow"><div className="lbl">{L(`${a.label || a.email} 允许发给 AI`, `Allow AI for ${a.label || a.email}`)}</div>{!a.aiAllowed && <div className="sub">{L('已关闭：只用本地规则分类，内容不出这台电脑', 'Off: sorted by local rules only; content never leaves this computer')}</div>}</div>
              <Switch label={L(`${a.email} 允许发给 AI`, `Allow AI for ${a.email}`)} on={a.aiAllowed} onChange={async (v) => { await api.updateAccount(a.id, { aiAllowed: v }); s.refreshMeta() }} />
            </div>
          ))}
          <div className="gr" style={{ minHeight: 52 }}>
            <Icon name="lock" style={{ color: 'var(--sec)' }} />
            <div className="grow"><div className="lbl">{L('AI 只能起草，不能自动发送', 'AI can only draft, never send')}</div><div className="sub">{L('防止来信里夹带指令让 AI 代你发信，这一项不能关闭', "Stops instructions hidden in incoming mail from making AI send email for you. This can't be turned off")}</div></div>
            <span className="tag">{L('始终开启', 'Always on')}</span>
          </div>
        </div>
      </section>
      <section>
        <h2 className="gh">{L('外部 AI Agent（MCP）', 'External AI agents (MCP)')}</h2>
        <div className="group sq">
          <div className="gr" style={{ minHeight: 52 }}>
            <div className="grow"><div className="lbl">{L('允许 AI Agent 通过 MCP 读取邮件', 'Let AI agents read mail through MCP')}</div><div className="sub">{L('打开后，你在自己电脑上配置的 AI Agent（Claude Desktop、Cursor 等）可以搜索和读取这台电脑上已同步的邮件、AI 批注和待办。只能读，不能发信、删除或移动；上面关了「允许发给 AI」的邮箱读不到。邮件内容会交给你的 Agent 所用的模型服务', 'When on, AI agents you set up on this computer (Claude Desktop, Cursor, etc.) can search and read synced mail, AI notes and to-dos here. Read only: they can’t send, delete or move mail, and mailboxes with “Allow AI” turned off above stay hidden. Mail content is passed to the model service your agent uses')}</div></div>
            <Switch label={L('允许 AI Agent 通过 MCP 读取邮件', 'Let AI agents read mail through MCP')} on={!!st.mcpRead} onChange={async (v) => {
              if (v && !await ask(L('打开后：\n\n· 你配置的 AI Agent 能读到允许发给 AI 的邮箱里、已同步到这台电脑的邮件、AI 批注和待办\n· 邮件内容会发给这个 Agent 自己用的模型服务\n· 随时可以在这里关掉，关掉后立刻生效\n\n确定打开吗？', 'Once on:\n\n· AI agents you set up can read the synced mail, AI notes and to-dos of mailboxes that allow AI\n· Mail content is sent to the model service the agent itself uses\n· You can turn this off here at any time; it takes effect immediately\n\nTurn it on?'))) return
              s.saveSettings({ mcpRead: v })
            }} />
          </div>
          {st.mcpRead && <McpConfig />}
        </div>
      </section>
    </>
  )
}

function McpConfig() {
  const s = useApp()
  const text = JSON.stringify({ mcpServers: { kojoomail: { command: s.exePath || 'kojoomail', args: ['--mcp'] } } }, null, 2)
  const copy = async () => {
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      // 剪贴板接口用不了时退回老办法
      const t = document.createElement('textarea')
      t.value = text
      t.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(t)
      t.select()
      try { ok = document.execCommand('copy') } catch { ok = false }
      t.remove()
    }
    if (ok) s.toast(L('已复制', 'Copied'), { ttl: 2500 })
    else s.toast(L('没复制成功，请手动选中复制', "Couldn't copy. Select the text and copy it manually."), { kind: 'err' })
  }
  return (
    <div style={{ padding: '10px 14px 12px' }}>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <div className="sub grow">{L('把下面这段加进 Agent 的 MCP 配置里，然后重启 Agent', 'Add this to your agent MCP configuration, then restart the agent')}</div>
        <button className="btn sm sq" onClick={copy}>{L('复制', 'Copy')}</button>
      </div>
      <pre className="mono" style={{ margin: 0, background: 'var(--sunken)', padding: '8px 10px', borderRadius: 6, fontSize: 12, userSelect: 'text', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{text}</pre>
    </div>
  )
}

function NotifyPrivacy() {
  const s = useApp()
  const st = s.settings!
  return (
    <>
      <Head title={L('通知与隐私', 'Notifications & privacy')} lead={L('什么时候打扰你，以及邮件里的追踪图片。', 'When to interrupt you, and tracking images in email.')} />
      <section>
        <h2 className="gh">{L('新邮件通知', 'New mail notifications')}</h2>
        <div className="group sq">
          <div className="gr" style={{ minHeight: 56 }}><div><div className="lbl">{L('提醒哪些邮件', 'Notify me about')}</div><div className="sub">{L('「重点」= AI 判断要尽快处理的、询盘；没开 AI 时提醒所有非广告邮件', 'Important = inquiries and mail AI thinks needs attention soon. Without AI, all non-promotional mail')}</div></div>
            <Seg small value={st.notify} onChange={(v) => s.saveSettings({ notify: v })} options={[['important', L('只提醒重点', 'Important only')], ['all', L('全部', 'All')], ['none', L('不提醒', 'None')]]} />
          </div>
          {st.notify !== 'none' && (
            <div className="gr" style={{ minHeight: 56 }}><div><div className="lbl">{L('通知里显示主题和摘要', 'Show subject and summary')}</div><div className="sub">{L('关掉后只显示发件人，锁屏或共享屏幕时别人看不到邮件内容', 'When off, only the sender is shown, so nothing leaks on a lock screen or shared screen')}</div></div>
              <Switch label={L('通知里显示主题和摘要', 'Show subject and summary')} on={st.notifyPreview} onChange={(v) => s.saveSettings({ notifyPreview: v })} />
            </div>
          )}
        </div>
      </section>
      <section>
        <h2 className="gh">{L('远程图片', 'Remote images')}</h2>
        <div className="group sq">
          <div className="gr" style={{ minHeight: 56 }}><div><div className="lbl">{L('邮件里的网络图片', 'Images from the web')}</div><div className="sub">{L('发件人可以通过图片知道你什么时候读了信', 'Senders can use images to see when you read their email')}</div></div>
            <Seg small value={st.remoteImages} onChange={(v) => s.saveSettings({ remoteImages: v })} options={[['ask', L('每次手动显示', 'Ask each time')], ['always', L('总是显示', 'Always show')]]} />
          </div>
          <div className="gr"><div><div className="lbl">{L('撤销时间', 'Undo window')}</div><div className="sub">{L('发送、归档、删除后多少秒内可以撤销', 'How long you can undo after sending, archiving or deleting')}</div></div>
            <Seg small value={String(st.undoSendSecs)} onChange={(v) => s.saveSettings({ undoSendSecs: Number(v) })} options={[['0', L('不等待', 'Off')], ['5', L('5 秒', '5 sec')], ['10', L('10 秒', '10 sec')]]} />
          </div>
        </div>
      </section>
    </>
  )
}

function Keys() {
  const rows: [string, string][] = [
    [L('写邮件', 'New email'), 'C'], [L('搜索', 'Search'), L('Ctrl K 或 /', 'Ctrl K or /')], [L('全选列表', 'Select all'), 'Ctrl A'], [L('下一封 / 上一封', 'Next / previous'), 'J / K'], [L('回复', 'Reply'), 'R'], [L('全部回复', 'Reply all'), 'A'], [L('转发', 'Forward'), 'F'],
    [L('归档', 'Archive'), 'E'], [L('删除', 'Delete'), 'Del'], [L('标为重点', 'Mark important'), 'S'], [L('标为已读 / 未读', 'Mark read / unread'), 'U'], [L('发送', 'Send'), 'Ctrl ↵'], [L('设置', 'Settings'), 'Ctrl ,'], [L('关闭弹窗 / 取消选择', 'Close / clear selection'), 'Esc'],
  ]
  return (
    <>
      <Head title={L('快捷键', 'Shortcuts')} lead={L('邮件多的时候，用键盘最快。', 'With lots of mail, the keyboard is fastest.')} />
      <div className="group sq">
        {rows.map(([k, v]) => <div className="gr" key={k}><span className="lbl">{k}</span><span className="kbd">{keyText(v)}</span></div>)}
      </div>
    </>
  )
}

function About() {
  const s = useApp()
  return (
    <>
      <Head title={L('关于', 'About')} lead={L('Kojoo Mail：所有邮箱，一个收件箱。', 'Kojoo Mail: all your mailboxes, one inbox.')} />
      <div className="group sq">
        <div className="gr"><span className="lbl">{L('版本', 'Version')}</span>
          <div className="row" style={{ gap: 8 }}>
            <span className="mono" style={{ fontSize: 12.5 }}>{s.version}</span>
            <button className="btn sm sq" onClick={async () => {
              try {
                const u = await api.checkUpdate()
                if (!u) { s.toast(L('已经是最新版', "You're up to date")); return }
                if (await ask(L(`有新版本 ${u.version}${u.notes ? `

${u.notes}` : ''}

现在下载安装？装好后会自动重启。`, `Version ${u.version} is available${u.notes ? `

${u.notes}` : ''}

Download and install now? The app restarts when it's done.`))) s.installUpdate(u.version)
              } catch (e) { s.toast(errText(e), { kind: 'err' }) }
            }}>{L('检查更新', 'Check for updates')}</button>
          </div>
        </div>
        <div className="gr"><div><div className="lbl">{L('数据存在哪', 'Where your data lives')}</div><div className="sub mono">{L(`${DATA_DIR}（邮件缓存和设置），密码在${VAULT}`, `${DATA_DIR} (mail cache and settings); passwords in ${VAULT}`)}</div></div></div>
        <div className="gr"><div><div className="lbl">{L('后台资源', 'Background resources')}</div><div className="sub">{L('每个账号只保持一条连接，空闲时等服务器推送，不轮询；AI 一次只处理一封', 'One connection per account that waits for the server to push new mail, no polling; AI handles one email at a time')}</div></div></div>
        <div className="gr" style={{ minHeight: 52 }}>
          <div><div className="lbl">{L('遇到问题', 'Having trouble?')}</div><div className="sub">{L('导出连接、同步、发信的记录发给开发者。邮箱地址会打码，不含密码和邮件内容', 'Export connection, sync and sending logs to send to the developer. Addresses are masked; no passwords or mail content')}</div></div>
          <button className="btn sm sq" onClick={async () => { try { const p = await api.exportDiagnostics(); s.toast(L(`已保存：${p}`, `Saved: ${p}`)) } catch (e) { s.toast(errText(e), { kind: 'err' }) } }}>{L('导出诊断信息', 'Export diagnostics')}</button>
        </div>
        <div className="gr"><span className="lbl">{L('彻底退出', 'Quit completely')}</span><button className="btn sm sq" onClick={() => { getCurrentWindow().hide(); api.quit() }}>{L('退出 Kojoo Mail', 'Quit Kojoo Mail')}</button></div>
      </div>
    </>
  )
}

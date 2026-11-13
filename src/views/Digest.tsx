import { useEffect, useState } from 'react'
import { Icon } from '../icons'
import { useApp } from '../store'
import { api, errText, on, type Digest, type DigestItem, type Overview } from '../lib/api'
import { dueLabel, shortTime } from '../lib/format'
import { Kojoo, Loader, TipText } from '../ui'
import { L, EN } from '../lib/i18n'

const daysAgo = (t: number) => Math.max(1, Math.floor((Date.now() / 1000 - t) / 86400))

/** 今日简报：要回复的、账单、到期待办、待跟进、可以一键整理的通知订阅；开头一段 AI 概要 */
export default function DigestPage() {
  const s = useApp()
  const [d, setD] = useState<Digest | null>(null)
  const [ov, setOv] = useState<Overview | null>(null)
  const [ovBusy, setOvBusy] = useState(false)
  const [ovErr, setOvErr] = useState('')

  const load = () => api.digest().then(setD).catch((e) => s.toast(errText(e), { kind: 'err' }))
  const loadOverview = async (force = false) => {
    if (!s.aiConfigured) return
    setOvBusy(true); setOvErr('')
    try { setOv(await api.digestOverview(force)) } catch (e) { setOvErr(errText(e)) } finally { setOvBusy(false) }
  }
  useEffect(() => {
    load(); loadOverview()
    // 邮件有变化时刷新清单（概要不自动重写，省额度；点刷新再写）
    let t: ReturnType<typeof setTimeout> | null = null
    const u = on('mail-changed', () => { if (t) clearTimeout(t); t = setTimeout(load, 600) })
    return () => { u.then((f) => f()); if (t) clearTimeout(t) }
  }, [])

  const today = new Date().toLocaleDateString(EN ? 'en-US' : 'zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
  const hour = new Date().getHours()
  const hello = hour < 6 ? L('夜深了', 'Working late') : hour < 12 ? L('早上好', 'Good morning') : hour < 18 ? L('下午好', 'Good afternoon') : L('晚上好', 'Good evening')
  const tidy = async () => {
    s.set({ page: 'mail', view: { kind: 'all' }, filter: 'all', cats: [], search: '', ask: null, selected: null, open: null, checked: new Set() })
    await s.loadList()
    await s.tidy()
  }

  const row = (x: DigestItem, right?: React.ReactNode, view?: 'followup' | 'bills') => (
    <button key={x.id} className="dg-row" onClick={() => s.openMsg(x.id, view ? { kind: view } : undefined)}>
      <span className={`dg-dot${!x.seen ? ' on' : ''}`} />
      <span className="dg-main">
        <span className="dg-top"><b className="truncate">{x.who}</b>{x.high && <span className="tag hot">{L('高优先', 'High priority')}</span>}<span className="dg-time">{right ?? shortTime(x.date)}</span></span>
        <span className="dg-subj truncate">{x.subject || L('（无主题）', '(no subject)')}</span>
        {x.summary && <span className="dg-sum">{x.summary}</span>}
      </span>
    </button>
  )

  return (
    <div className="digest">
      <div className="dg-wrap">
        <header className="dg-head">
          <div>
            <h1>{hello}</h1>
            <div className="dg-date">{today}{d ? L(` · 过去 24 小时收到 ${d.newCount} 封`, ` · ${d.newCount} ${d.newCount === 1 ? 'email' : 'emails'} in the last 24 hours`) : ''}</div>
          </div>
          <button className="tb" aria-label={L('刷新', 'Refresh')} data-tip={L('刷新简报', 'Refresh digest')} onClick={() => { load(); loadOverview(true) }}><Icon name="refresh" /></button>
        </header>

        {!s.aiConfigured && (
          <div className="group sq dg-ov" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <Icon name="sparkle" style={{ color: 'var(--sec)', flex: 'none' }} />
            <span className="grow" style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--sec)' }}>{L('还没设置 AI。今日概要和「要回复」要靠 AI 读信判断，设置好后这里会自动出现；待办、待跟进现在就能用。', "AI isn't set up yet. The overview and Needs reply rely on AI reading your mail and will appear here once it's set up. To-dos and Follow up work now.")}</span>
            <button className="btn sm sq" style={{ flex: 'none' }} onClick={s.openAiSettings}>{L('去设置', 'Set up')}</button>
          </div>
        )}
        {s.aiConfigured && (
          <div className="ai-card sq dg-ov">
            <div className="ai-strip">
              {ovBusy ? <span style={{ color: '#F2A487', display: 'inline-flex' }}><Kojoo width={26} stroke={8} /></span> : <Icon name="sparkle" style={{ color: '#F2A487' }} />}
              <span className="t">{L('今日概要', 'Overview')}</span>
              <TipText className="s truncate">{ovBusy ? L('正在看今天的邮件…', "Reading today's mail…") : ov ? L(`${new Date(ov.at * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 生成`, `Generated at ${new Date(ov.at * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`) : ''}</TipText>
            </div>
            <div className="dg-ov-body">
              {ovBusy && !ov ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}><div className="skel" style={{ height: 9, width: '92%' }} /><div className="skel" style={{ height: 9, width: '78%' }} /><div className="skel" style={{ height: 9, width: '60%' }} /></div>
              ) : ovErr && !ov ? (
                <span style={{ color: 'var(--sec)' }}>{L('概要没生成出来：', "Couldn't write the overview: ")}{ovErr.slice(0, 120)} <button className="btn link sm" onClick={() => loadOverview(true)}>{L('重试', 'Retry')}</button></span>
              ) : ov?.text}
            </div>
          </div>
        )}

        {!d ? <Loader text="" width={160} /> : (
          <>
            <Section icon="reply" title={L('要回复', 'Needs reply')} count={d.reply.length} empty={s.aiConfigured ? L('最近三天的询盘、待办和私人来信都处理过了', 'All inquiries, to-dos and personal emails from the last three days are handled') : L('设置 AI 后，这里会列出需要你回复的询盘、待办和私人来信', 'Once AI is set up, inquiries, to-dos and personal emails that need a reply will show up here')}>
              {d.reply.map((x) => row(x))}
            </Section>

            {d.todos.length > 0 && (
              <Section icon="todo" title={L('今明两天的待办', 'Due today and tomorrow')} count={d.todos.length} more={{ label: L('全部待办', 'All to-dos'), run: () => s.set({ page: 'todo', selected: null }) }}>
                {d.todos.map((t) => (
                  <button key={t.id} className="dg-row" onClick={() => (t.msgId ? s.openMsg(t.msgId) : s.set({ page: 'todo', selected: null }))}>
                    <span className="dg-dot" />
                    <span className="dg-main">
                      <span className="dg-top"><span className="truncate" style={{ fontSize: 13.5 }}>{t.text}</span>{t.due && <span className={`tag${t.due * 1000 < Date.now() + 86400000 ? ' hot' : ''}`}>{dueLabel(t.due)}</span>}</span>
                    </span>
                  </button>
                ))}
              </Section>
            )}

            {d.followupTotal > 0 && (
              <Section icon="wait" title={L('待跟进', 'Follow up')} count={d.followupTotal} hint={L('发出 3 天以上，对方还没回', 'Sent over 3 days ago, no reply yet')} more={{ label: L('全部', 'All'), run: () => s.go({ kind: 'followup' }) }}>
                {d.followups.map((x) => row(x, L(`${daysAgo(x.date)} 天没回`, `${daysAgo(x.date)}d no reply`), 'followup'))}
              </Section>
            )}

            {d.bills.length > 0 && (
              <Section icon="receipt" title={L('最近一周的账单', 'Bills this week')} count={d.bills.length} more={{ label: L('账单发票', 'Bills & invoices'), run: () => s.go({ kind: 'bills' }) }}>
                {d.bills.map((x) => row(x, undefined, 'bills'))}
              </Section>
            )}

            {d.bulkUnread > 0 && (
              <div className="group sq dg-bulk">
                <div className="gr">
                  <Icon name="inbox" style={{ color: 'var(--ter)' }} />
                  <span className="lbl grow">{L(`另外还有 ${d.bulkUnread} 封没读的通知和订阅`, `Plus ${d.bulkUnread} unread ${d.bulkUnread === 1 ? 'notification or newsletter' : 'notifications and newsletters'}`)}</span>
                  <button className="btn sm sq" onClick={tidy}><Icon name="sparkle" size={14} />{L('一键整理', 'Tidy up')}</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Section({ icon, title, count, hint, empty, more, children }: { icon: string; title: string; count: number; hint?: string; empty?: string; more?: { label: string; run: () => void }; children: React.ReactNode }) {
  return (
    <section className="dg-sec">
      <div className="dg-sec-h">
        <Icon name={icon} size={15} />
        <span>{title}</span>
        {count > 0 && <span className="num">{count}</span>}
        {hint && <span className="hint">{hint}</span>}
        {more && <button className="btn link sm" style={{ marginLeft: 'auto' }} onClick={more.run}>{more.label} →</button>}
      </div>
      <div className="group sq">
        {count === 0 && empty ? <div className="dg-empty">{empty}</div> : children}
      </div>
    </section>
  )
}

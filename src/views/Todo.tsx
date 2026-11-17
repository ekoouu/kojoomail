import { Fragment, useEffect, useState } from 'react'
import { Icon } from '../icons'
import { ask } from '../lib/ask'
import { useApp } from '../store'
import { api, errText, on, type Todo } from '../lib/api'
import { dueLabel } from '../lib/format'
import { Empty, Seg, useMenu } from '../ui'
import { L, plural } from '../lib/i18n'

function bucket(t: Todo) {
  if (t.done) return '已完成'
  if (!t.due) return '以后'
  const d = new Date(t.due * 1000)
  const now = new Date()
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(d) - day(now)) / 86400000)
  if (diff < 0) return '逾期'
  if (diff === 0) return '今天'
  if (diff < 7) return '本周'
  return '以后'
}
const ORDER = ['逾期', '今天', '本周', '以后', '已完成']
/** 分组标识是中文，显示时按语言换 */
const BUCKET_EN: Record<string, string> = { 逾期: 'Overdue', 今天: 'Today', 本周: 'This week', 以后: 'Later', 已完成: 'Done' }
const bucketLabel = (b: string) => L(b, BUCKET_EN[b] ?? b)

const dueAt = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(18, 0, 0, 0); return Math.floor(d.getTime() / 1000) }

export default function TodoPage() {
  const s = useApp()
  const [filter, setFilter] = useState('all')
  const [list, setList] = useState<Todo[] | null>(null)
  const [sel, setSel] = useState<number | null>(null)
  const [newText, setNewText] = useState('')
  const menu = useMenu()

  const load = () => api.todos(filter).then((v) => { setList(v); if (sel && !v.some((t) => t.id === sel)) setSel(null) }).catch((e) => s.toast(errText(e), { kind: 'err' }))
  useEffect(() => { load() }, [filter])
  useEffect(() => { const u = on('mail-changed', () => load()); const u2 = on('ai-state', () => load()); return () => { u.then((f) => f()); u2.then((f) => f()) } }, [filter])

  const todo = list?.find((t) => t.id === sel) || null
  const set = async (id: number, p: Parameters<typeof api.todoSet>[1]) => { await api.todoSet(id, p); load(); s.refreshMeta() }
  const open = (list || []).filter((t) => !t.done).length
  const overdue = (list || []).filter((t) => bucket(t) === '逾期').length
  const sorted = [...(list || [])].sort((a, b) => ORDER.indexOf(bucket(a)) - ORDER.indexOf(bucket(b)))

  // 一键清除：先问一句再清（清掉的找不回来）
  const clear = async (scope: 'done' | 'ai' | 'all', what: string) => {
    if (!await ask(L(`清除${what}？不管现在看的是哪个页签，都按全部待办算。清掉后找不回来。`, `Clear ${what}? This covers all to-dos, whichever tab you're on, and can't be undone.`))) return
    try { const n = await api.todoClear(scope); setSel(null); load(); s.refreshMeta(); s.toast(n ? L(`已清除 ${n} 项待办`, `${plural(n, '', 'to-do')} cleared`) : L('没有可清除的', 'Nothing to clear')) } catch (e) { s.toast(errText(e), { kind: 'err' }) }
  }
  const clearMenu = (el: HTMLElement) => menu.openBelow(el, [
    { label: L('清除已完成的', 'Clear completed'), run: () => clear('done', L('全部已完成的待办', 'all completed to-dos')) },
    { label: L('清除 AI 自动生成的', 'Clear AI-generated'), run: () => clear('ai', L('AI 自动生成、还没办的待办（自己加的不动）', 'the open to-dos AI generated (your own stay)')) },
    'sep',
    { label: L('清除全部待办', 'Clear all to-dos'), run: () => clear('all', L('全部待办（包括没办完的和自己加的）', 'all to-dos, including open ones and your own')) },
  ])

  const dueMenu = (el: HTMLElement, t: Todo) => menu.openBelow(el, [
    { label: L('今天', 'Today'), run: () => set(t.id, { due: dueAt(0) }) },
    { label: L('明天', 'Tomorrow'), run: () => set(t.id, { due: dueAt(1) }) },
    { label: L('下周一', 'Next Monday'), run: () => { const d = new Date(); set(t.id, { due: dueAt(((8 - d.getDay()) % 7) || 7) }) } },
    'sep',
    { label: L('不设截止', 'No due date'), run: () => set(t.id, { due: null }) },
  ])

  return (
    <div className="todo-page">
      <section className="todo-list">
        <div className="list-head" style={{ padding: '16px 20px 10px' }}>
          <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
            <h1>{L('待办', 'To-dos')}</h1>
            <span style={{ fontSize: 12.5, color: 'var(--ter)' }}>{L(`${open} 项未完成`, `${open} open`)}{overdue ? L(` · ${overdue} 项逾期`, ` · ${overdue} overdue`) : ''}</span>
          </div>
          <div className="row" style={{ marginTop: 12, gap: 10, flexWrap: 'wrap' }}>
            <div style={{ width: 360, maxWidth: '100%' }}><Seg value={filter} onChange={setFilter} options={[['all', L('全部', 'All')], ['today', L('今天', 'Today')], ['week', L('本周', 'This week')], ['done', L('已完成', 'Done')]]} /></div>
            <form className="row" style={{ marginLeft: 'auto', gap: 6 }} onSubmit={async (e) => {
              e.preventDefault()
              if (!newText.trim()) return
              try { await api.todoAdd(newText, null, null); setNewText(''); load(); s.refreshMeta() } catch (er) { s.toast(errText(er), { kind: 'err' }) }
            }}>
              <input className="field inset" style={{ width: 220, maxWidth: '100%' }} placeholder={L('新建待办，回车添加', 'New to-do, press Enter to add')} value={newText} onChange={(e) => setNewText(e.target.value)} aria-label={L('新建待办', 'New to-do')} />
              <button type="button" className="btn sq" onClick={(e) => clearMenu(e.currentTarget)}><Icon name="trash" size={15} />{L('清除', 'Clear')}</button>
            </form>
          </div>
        </div>
        <div className="rows" style={{ padding: '0 12px 20px' }}>
          {list && list.length === 0 ? (
            <Empty icon="todo" title={filter === 'done' ? L('还没有完成的待办', 'No completed to-dos yet') : L('没有待办', 'No to-dos')} sub={!s.aiConfigured ? <>{L('可以在上面直接新建。', 'Add one above.')}<br />{L('设置 AI 后，还会从邮件里自动提取', 'Set up AI and they\'ll also be pulled from your email')}</>
              : s.settings?.aiTodos === false ? <>{L('可以在上面直接新建。', 'Add one above.')}<br />{L('「从邮件里自动生成待办」已关闭，可以在 设置 → AI 与模型 里打开', '"Create to-dos from emails" is off; turn it on under Settings → AI & models')}</>
              : <>{L('AI 会从需要你处理的邮件里自动提取，', 'AI pulls them from emails that need your action,')}<br />{L('也可以在上面直接新建', 'or add one above')}</>}>
              {!s.aiConfigured && <button className="btn sm sq" onClick={s.openAiSettings}>{L('去设置 AI', 'Set up AI')}</button>}
              {s.aiConfigured && s.settings?.aiTodos === false && <button className="btn sm sq" onClick={s.openAiSettings}>{L('去设置', 'Open settings')}</button>}
            </Empty>
          ) : sorted.map((t, i) => {
            const b = bucket(t)
            const showH = i === 0 || bucket(sorted[i - 1]) !== b
            const acc = s.accounts.find((a) => a.id === t.accountId)
            return (
              <Fragment key={t.id}>
                {showH && <div className="group-h" style={{ color: b === '逾期' ? 'var(--accent-text)' : undefined, padding: '12px 12px 6px' }}>{bucketLabel(b)}</div>}
                <div className={`trow${sel === t.id ? ' sel' : ''}${t.done ? ' done' : ''}`} onClick={() => setSel(t.id)}>
                  <input type="checkbox" className="check" checked={t.done} onClick={(e) => e.stopPropagation()} onChange={(e) => set(t.id, { done: e.target.checked })} aria-label={L('完成', 'Done')} style={{ marginTop: 1 }} />
                  <div style={{ minWidth: 0 }}>
                    <div className="t">{t.text}</div>
                    {(t.srcSubject || t.srcFrom) && (
                      <div className="src"><span className="dot" style={{ background: acc?.color || 'var(--ter)' }} /><span className="truncate">{[t.srcFrom, t.srcSubject].filter(Boolean).join(' · ')}</span></div>
                    )}
                  </div>
                  <span className="row" style={{ gap: 6 }}>
                    {t.source === 'ai' && <span className="tag"><Icon name="sparkle" />AI</span>}
                    {t.due && !t.done && <span className={`tag${b === '逾期' ? ' hot' : ''}`}>{dueLabel(t.due)}</span>}
                  </span>
                </div>
              </Fragment>
            )
          })}
        </div>
      </section>

      <aside className="todo-detail">
        {!todo ? <Empty icon="todo" title={L('选一项待办', 'Select a to-do')} sub={L('可以改截止时间，或者直接跳到来源邮件处理', 'Change its due date, or jump to the email it came from')} /> : (
          <>
            <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
              <input type="checkbox" className="check" style={{ width: 20, height: 20, marginTop: 4 }} checked={todo.done} onChange={(e) => set(todo.id, { done: e.target.checked })} aria-label={L('完成', 'Done')} />
              <textarea defaultValue={todo.text} key={todo.id} aria-label={L('待办内容', 'To-do text')} rows={2}
                style={{ flex: 1, border: 0, outline: 0, background: 'transparent', resize: 'none', font: '600 17px/1.4 var(--sans)', color: 'var(--ink)' }}
                onBlur={(e) => { if (e.target.value.trim() && e.target.value !== todo.text) set(todo.id, { text: e.target.value }) }} />
            </div>
            <div className="group sq">
              <div className="gr"><span style={{ color: 'var(--sec)', fontSize: 13 }}>{L('截止', 'Due')}</span><button className="btn sm sq" onClick={(e) => dueMenu(e.currentTarget, todo)}>{todo.due ? dueLabel(todo.due) : L('不设', 'None')}<Icon name="down" size={12} /></button></div>
              <div className="gr"><span style={{ color: 'var(--sec)', fontSize: 13 }}>{L('优先级', 'Priority')}</span>
                <Seg small value={todo.priority === 'high' ? 'high' : 'normal'} onChange={(v) => set(todo.id, { priority: v })} options={[['normal', L('普通', 'Normal')], ['high', L('高', 'High')]]} />
              </div>
              <div className="gr"><span style={{ color: 'var(--sec)', fontSize: 13 }}>{L('来源', 'Source')}</span><span style={{ fontSize: 13 }}>{todo.source === 'ai' ? L('AI 从邮件里提取', 'Extracted by AI from an email') : L('手动添加', 'Added manually')}</span></div>
            </div>
            {todo.msgId && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ter)', margin: '0 0 6px 2px' }}>{L('来源邮件', 'Source email')}</div>
                <button className="group sq" style={{ width: '100%', textAlign: 'left', border: 0, padding: 12, cursor: 'pointer', color: 'var(--ink)' }}
                  onClick={async () => {
                    s.set({ page: 'mail', view: { kind: 'all' }, filter: 'all', search: '' })
                    await s.loadList()
                    s.select(todo.msgId!)
                  }}>
                  <div style={{ fontSize: 12, color: 'var(--sec)' }}>{todo.srcFrom}</div>
                  <div style={{ fontFamily: 'var(--serif)', fontSize: 14, fontWeight: 600, marginTop: 3 }}>{todo.srcSubject || L('（无主题）', '(No subject)')}</div>
                  <div style={{ fontSize: 12, color: 'var(--navy)', marginTop: 6 }}>{L('打开邮件 →', 'Open email →')}</div>
                </button>
              </div>
            )}
            <div className="row" style={{ gap: 8 }}>
              {todo.msgId && s.aiConfigured && (
                <button className="btn primary sq grow" onClick={async () => {
                  try { const m = await api.get(todo.msgId!); s.toast(L('正在起草…', 'Drafting…'), { ttl: 2500 }); const t = await api.aiDraft(m.id, 'pro', m.ai?.replyLang || 'auto', `重点完成这件事：${todo.text}`); s.openCompose('reply', m, { prefill: { body: t } }) } catch (e) { s.toast(errText(e), { kind: 'err' }) }
                }}>{L('起草回复', 'Draft reply')}</button>
              )}
              <button className="btn sq" onClick={() => set(todo.id, { due: dueAt(1) })}>{L('推迟到明天', 'Move to tomorrow')}</button>
              <button className="tb" aria-label={L('删除待办', 'Delete to-do')} data-tip={L('删除', 'Delete')} onClick={async () => { await api.todoDelete(todo.id); setSel(null); load(); s.refreshMeta() }}><Icon name="trash" /></button>
            </div>
          </>
        )}
      </aside>
      {menu.node}
    </div>
  )
}

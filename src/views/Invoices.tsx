import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons'
import { useApp } from '../store'
import { api, errText, on, type InvoiceDetail, type InvoiceFilter, type InvoiceListing, type InvoiceProject, type InvoiceRow } from '../lib/api'
import { ask } from '../lib/ask'
import { shortTime } from '../lib/format'
import { Empty, Loader, Sheet, useMenu } from '../ui'
import { L, plural } from '../lib/i18n'

/** 下拉框里「全部」那一项的值（真实的购买方名字不会是它） */
const ALL = '__all__'
/** 分 → ¥1,234.50 */
const money = (c: number | null) => (c == null ? '—' : `¥${(c / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const yuan = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2))
/** 这个月的第一天、最后一天 */
const monthRange = (m: string) => {
  const [y, mo] = m.split('-').map(Number)
  const last = new Date(y, mo, 0).getDate()
  return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, '0')}` }
}
/** 发票信息是从哪种文件读出来的 */
const sourceText = (r: InvoiceRow) =>
  r.edited ? L('手工改过', 'Edited by you')
    : r.source === 'xml' ? L('读自发票自带的数据文件（XML），准确', 'Read from the invoice data file (XML): exact')
    : r.source === 'ofd' ? L('读自 OFD 文件里登记的数据', 'Read from the data inside the OFD file')
    : L('读自 PDF 里的文字，可能有出入，请核对', 'Read from the text in the PDF; may be off, please check')

/** 发票台账：一张发票一行（重复收到的并成一张），按购买方 / 时间 / 邮箱筛选，把筛出来的导出成压缩包 + 汇总表 */
export default function InvoicesPage() {
  const s = useApp()
  const [f, setF] = useState<InvoiceFilter>({})
  const [month, setMonth] = useState('')
  const [q, setQ] = useState('')
  const [data, setData] = useState<InvoiceListing | null>(null)
  const [sel, setSel] = useState<number | null>(null)
  const [left, setLeft] = useState(0)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  // 现在看的是哪个项目（null = 全部发票）；正在新建 / 编辑的项目
  const [pid, setPid] = useState<number | null>(null)
  const [editing, setEditing] = useState<Omit<InvoiceProject, 'count' | 'total'> | null>(null)
  const pidRef = useRef(pid)
  pidRef.current = pid
  /** 换着看（全部 / 某个项目）：筛选清掉，标签上写几张，进去就看到几张 */
  const view = (id: number | null) => { setPid(id); setF({}); setMonth(''); setQ(''); setSel(null) }

  const filter: InvoiceFilter = useMemo(() => ({ ...f, ...(month ? monthRange(month) : {}), q: q.trim() || undefined, project: pid ?? undefined }), [f, month, q, pid])
  const load = () => {
    const mine = ++seq.current
    api.invoiceList(filter).then((v) => { if (mine === seq.current) setData(v) }).catch((e) => s.toast(errText(e), { kind: 'err' }))
  }
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => { const t = setTimeout(load, q ? 200 : 0); return () => clearTimeout(t) }, [filter])
  // 打开页面：把还没看过的邮件在后台看一遍；看的过程中、看完都刷新列表
  useEffect(() => {
    const u = on<{ kind?: 'scan' | 'row'; left?: number }>('invoice-changed', (p) => { if (p.kind === 'scan') setLeft(p.left ?? 0); loadRef.current() })
    u.then(() => api.invoiceSync().then(setLeft).catch(() => {}))
    // 来了新邮件：看看有没有要扫的。邮件变动很频繁，最多 15 秒查一次
    let last = Date.now()
    const u2 = on('mail-changed', () => { if (Date.now() - last < 15000) return; last = Date.now(); api.invoiceSync().then(setLeft).catch(() => {}) })
    return () => { u.then((x) => x()); u2.then((x) => x()) }
  }, [])

  const items = data?.items ?? []
  const row = items.find((r) => r.id === sel) ?? null
  const set = (p: Partial<InvoiceFilter>) => { setF({ ...f, ...p }); setSel(null) }
  const filtered = f.buyer !== undefined || f.seller !== undefined || f.accountId !== undefined || !!month || !!q.trim() || !!f.onlyCheck
  const accName = (id: number) => { const a = s.accounts.find((x) => x.id === id); return a ? a.label || a.email : '' }
  const projects = data?.projects ?? []
  const project = projects.find((p) => p.id === pid) ?? null
  // 看着的项目被删了（或者还没加载出来就不在了）：回到全部
  // 只在列表更新时看（依赖里不放 pid）：刚建好的项目旧列表里还没有它，不能当成被删了
  useEffect(() => { if (data && pidRef.current != null && !data.projects.some((p) => p.id === pidRef.current)) setPid(null) }, [data])
  /** 项目的条件用一句话说出来 */
  const ruleText = (p: InvoiceProject) => {
    const parts = [
      p.buyer != null && (p.buyer || L('没读出购买方的', 'buyer not read')),
      p.seller != null && (p.seller || L('没读出销售方的', 'seller not read')),
      p.accounts.length > 0 && (p.accounts.map(accName).filter(Boolean).join(L('、', ', ')) || L('已经移除的邮箱', 'a removed mailbox')),
      (p.from || p.to) && `${p.from || L('最早', 'start')} ~ ${p.to || L('现在', 'now')}`,
    ].filter(Boolean)
    return parts.length ? parts.join(' · ') : L('没有设条件，只放手动加进来的发票', 'No conditions: only invoices you add by hand')
  }
  /** 新建项目：把现在筛着的条件带过去 */
  const newProject = () => setEditing({ id: 0, name: '', buyer: f.buyer ?? null, seller: f.seller ?? null, accounts: f.accountId ? [f.accountId] : [], from: month ? monthRange(month).from : '', to: month ? monthRange(month).to : '' })

  const exportAll = async () => {
    if (!items.length || busy) return
    setBusy(true)
    try {
      const [path, missing] = await api.invoiceExport(items.map((r) => r.id), project?.name)
      s.toast(missing ? L(`已导出到 ${path}（有 ${missing} 个文件没取到，邮件原文可能还没下载）`, `Exported to ${path} (${missing} files couldn't be fetched)`) : L(`已导出 ${items.length} 张发票到 ${path}`, `${plural(items.length, '', 'invoice')} exported to ${path}`))
    } catch (e) { s.toast(errText(e), { kind: 'err' }) }
    setBusy(false)
  }

  return (
    <div className="todo-page">
      <section className="todo-list">
        <div className="list-head" style={{ padding: '16px 20px 10px' }}>
          <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
            <h1>{project ? project.name : L('发票', 'Invoices')}</h1>
            {data && (
              <span style={{ fontSize: 12.5, color: 'var(--ter)' }}>
                {L(`${data.count} 张`, plural(data.count, '', 'invoice'))} · {L('合计', 'Total')} <b style={{ color: 'var(--ink)' }}>{money(data.total)}</b>
                {data.noAmount > 0 && L(`（${data.noAmount} 张没读出金额，未计入）`, ` (${data.noAmount} without an amount, not counted)`)}
              </span>
            )}
            <span className="row" style={{ marginLeft: 'auto', gap: 8 }}>
              <button className="btn link sm" onClick={() => s.go({ kind: 'bills' })} title={L('信用卡账单、付款和扣费提醒这类邮件', 'Statements, payment and charge notices')}>{L('账单类邮件', 'Bill emails')}</button>
              <button className="btn primary sq" disabled={!items.length || busy} onClick={exportAll}>
                <Icon name="download" size={15} />{busy ? L('正在导出…', 'Exporting…') : filtered ? L(`导出这 ${items.length} 张`, `Export these ${items.length}`) : L(`导出全部 ${items.length} 张`, `Export all ${items.length}`)}
              </button>
            </span>
          </div>
          {/* 项目：存下来的一组条件，符合的发票自动归进来。点一个只看它的 */}
          <div className="inv-projects">
            <button className={`inv-chip${pid == null ? ' on' : ''}`} onClick={() => view(null)}>{L('全部发票', 'All invoices')}{data ? <i>{data.all}</i> : null}</button>
            {projects.map((p) => (
              <button key={p.id} className={`inv-chip${pid === p.id ? ' on' : ''}`} onClick={() => view(p.id)} title={`${p.name} · ${ruleText(p)}`}><span>{p.name}</span><i>{p.count}</i></button>
            ))}
            <button className="inv-chip add" onClick={newProject}><Icon name="plus" size={12} />{pid == null && (f.buyer !== undefined || f.seller !== undefined || f.accountId !== undefined || !!month) && !q.trim() && !f.onlyCheck && !f.hidden ? L('把现在筛的存成项目', 'Save this filter as a project') : L('新建项目', 'New project')}</button>
          </div>
          {project && (
            <div className="row" style={{ marginTop: 8, gap: 10, fontSize: 12, color: 'var(--ter)', flexWrap: 'wrap' }}>
              <span>{L('归进来的条件：', 'Collects: ')}{ruleText(project)}</span>
              <button className="btn link sm" onClick={() => setEditing({ id: project.id, name: project.name, buyer: project.buyer ?? null, seller: project.seller ?? null, accounts: project.accounts, from: project.from, to: project.to })}>{L('改条件', 'Edit')}</button>
            </div>
          )}
          <div className="row inv-filters">
            <select className="field inset" value={f.buyer ?? ALL} onChange={(e) => set({ buyer: e.target.value === ALL ? undefined : e.target.value })} aria-label={L('购买方', 'Buyer')}>
              <option value={ALL}>{L('全部购买方', 'All buyers')}</option>
              {(data?.buyers ?? []).map(([b, n]) => <option key={b} value={b}>{b || L('没读出购买方', 'Buyer not read')}（{n}）</option>)}
            </select>
            <select className="field inset" value={month} onChange={(e) => { setMonth(e.target.value); setSel(null) }} aria-label={L('开票月份', 'Month')}>
              <option value="">{L('全部时间', 'Any time')}</option>
              {(data?.months ?? []).map(([m, n]) => <option key={m} value={m}>{m}（{n}）</option>)}
            </select>
            <select className="field inset" value={f.seller ?? ALL} onChange={(e) => set({ seller: e.target.value === ALL ? undefined : e.target.value })} aria-label={L('销售方', 'Seller')}>
              <option value={ALL}>{L('全部销售方', 'All sellers')}</option>
              {(data?.sellers ?? []).map(([b, n]) => <option key={b} value={b}>{b || L('没读出销售方', 'Seller not read')}（{n}）</option>)}
            </select>
            {(data?.accounts.length ?? 0) > 1 && (
              <select className="field inset" value={f.accountId ?? 0} onChange={(e) => set({ accountId: Number(e.target.value) || undefined })} aria-label={L('邮箱', 'Mailbox')}>
                <option value={0}>{L('全部邮箱', 'All mailboxes')}</option>
                {data!.accounts.map(([id, n]) => <option key={id} value={id}>{accName(id)}（{n}）</option>)}
              </select>
            )}
            <input className="field inset grow" style={{ minWidth: 120 }} placeholder={L('搜发票号、销售方、购买方', 'Search number, seller, buyer')} value={q} onChange={(e) => { setQ(e.target.value); setSel(null) }} aria-label={L('搜索发票', 'Search invoices')} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </div>
          <div className="row" style={{ marginTop: 8, gap: 12, fontSize: 12, color: 'var(--ter)', flexWrap: 'wrap' }}>
            {left > 0 && <span className="row" style={{ gap: 6 }}><span className="spin" />{L(`正在看邮件里的附件，还有 ${left} 封`, `Checking attachments, ${left} emails to go`)}</span>}
            {!!data?.check && <button className={`btn link sm${f.onlyCheck ? ' on' : ''}`} onClick={() => set({ onlyCheck: !f.onlyCheck })}>{f.onlyCheck ? L('← 看全部', '← Show all') : L(`${data.check} 张待核对`, `${data.check} to check`)}</button>}
            {(!!data?.hidden || f.hidden) && <button className="btn link sm" onClick={() => set({ hidden: !f.hidden })}>{f.hidden ? L('← 回到台账', '← Back to invoices') : L(`已隐藏 ${data!.hidden} 张`, `${data!.hidden} hidden`)}</button>}
            {!!data && data.count > items.length && <span style={{ color: 'var(--amber-text)' }}>{L(`只显示、只导出最近 ${items.length} 张（共 ${data.count} 张），按月份或购买方筛小一点`, `Showing and exporting only the latest ${items.length} of ${data.count}; narrow it down by month or buyer`)}</span>}
            {filtered && <button className="btn link sm" onClick={() => { setF({ hidden: f.hidden }); setMonth(''); setQ(''); setSel(null) }}>{L('清除筛选', 'Clear filters')}</button>}
          </div>
        </div>
        <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 20px' }}>
          {!data ? <Loader />
            : items.length === 0 ? (
              left > 0 ? <Loader text={L('正在看邮件里的附件…', 'Checking attachments…')} />
                : project && !filtered && !f.hidden ? <Empty icon="receipt" title={L('这个项目里还没有发票', 'No invoices in this project yet')} sub={L('符合条件的发票收到后会自动出现在这里；也可以在「全部发票」里把某一张手动加进来', 'Matching invoices show up here as they arrive; you can also add one by hand from All invoices')} />
                : <Empty icon="receipt" title={filtered || f.hidden ? L('没有符合条件的发票', 'No invoices match') : L('还没有发票', 'No invoices yet')}
                    sub={filtered || f.hidden ? undefined : <>{L('邮件附件里的发票（PDF、OFD、XML，压缩包里的也算）会自动出现在这里，', 'Invoices attached to your emails (PDF, OFD, XML, also inside archives) show up here automatically,')}<br />{L('同一张重复收到只算一张', 'and one received twice counts once')}</>} />
            ) : (
              <table className="inv-table">
                <thead><tr><th>{L('开票日期', 'Date')}</th><th>{L('销售方', 'Seller')}</th><th>{L('购买方', 'Buyer')}</th><th className="num">{L('价税合计', 'Total')}</th><th>{L('发票号', 'Number')}</th><th /></tr></thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id} className={sel === r.id ? 'sel' : ''} onClick={() => setSel(r.id)}>
                      <td className="mono">{r.date || <span className="miss">{L('待核对', 'Check')}</span>}</td>
                      <td className="truncate" title={r.seller}>{r.seller || <span className="miss">{L('待核对', 'Check')}</span>}</td>
                      <td className="truncate" title={r.buyer}>{r.buyer || <span className="miss">{L('待核对', 'Check')}</span>}</td>
                      <td className="num mono">{r.amount == null ? <span className="miss">{L('待核对', 'Check')}</span> : money(r.amount)}</td>
                      <td className="mono truncate" title={r.number}>{r.number ? (r.number.length > 10 ? `…${r.number.slice(-8)}` : r.number) : <span className="miss">{L('待核对', 'Check')}</span>}</td>
                      <td><div className="badges">
                        {r.mails > 1 && <span className="tag" title={L(`这张发票在 ${r.mails} 封邮件里收到过，只算一张`, `Received in ${r.mails} emails; counted once`)}>×{r.mails}</span>}
                        {s.accounts.length > 1 && r.accounts.length === 1 && <span className="acctname truncate" style={{ ['--ac' as string]: s.accounts.find((a) => a.id === r.accounts[0])?.color }}>{accName(r.accounts[0])}</span>}
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      </section>
      <aside className="todo-detail" style={{ width: 350 }}>
        {row ? <Detail key={row.id} r={row} onChanged={load} projects={projects} project={project} /> : (
          <Empty icon="receipt" title={L('选一张发票', 'Select an invoice')} sub={L('看它的文件、来自哪封邮件，读错的地方可以改', 'See its files and source emails; fix anything read wrong')} />
        )}
      </aside>
      {editing && <ProjectSheet p={editing} data={data} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); view(id) }} onDeleted={() => { setEditing(null); setPid(null) }} />}
    </div>
  )
}

/** 新建 / 修改一个项目：名字 + 归进来的条件 */
function ProjectSheet({ p, data, onClose, onSaved, onDeleted }: { p: Omit<InvoiceProject, 'count' | 'total'>; data: InvoiceListing | null; onClose: () => void; onSaved: (id: number) => void; onDeleted: () => void }) {
  const s = useApp()
  const [d, setD] = useState(p)
  // 条件里已经移除的邮箱：不悄悄去掉（去掉就成了「全部邮箱」），列出来让人自己取消勾
  const gone = d.accounts.filter((id) => !s.accounts.some((a) => a.id === id))
  const set = (x: Partial<typeof d>) => setD({ ...d, ...x })
  const saving = useRef(false)
  const title = p.id ? L('修改项目', 'Edit project') : L('新建项目', 'New project')
  const month = (offset: number) => { const t = new Date(); t.setDate(1); t.setMonth(t.getMonth() + offset); return monthRange(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`) }
  const save = async () => {
    if (!d.name.trim()) { s.toast(L('给项目起个名字', 'Give the project a name'), { kind: 'err' }); return }
    if (saving.current) return
    saving.current = true
    try { onSaved(await api.invoiceProjectSave(d)) } catch (e) { saving.current = false; s.toast(errText(e), { kind: 'err' }) }
  }
  const row = { display: 'flex', flexDirection: 'column', gap: 6 } as const
  return (
    <Sheet onClose={onClose} label={title} pinned>
      <div className="sh-head">
        <div className="grow"><h1>{title}</h1><p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--sec)' }}>{L('符合下面条件的发票会自动归进这个项目，以后新收到的也一样。条件留空就是不限。', 'Invoices that match these conditions are collected into the project, including ones that arrive later. Leave a condition empty for any.')}</p></div>
        <button className="tb" aria-label={L('关闭', 'Close')} onClick={onClose}><Icon name="x" /></button>
      </div>
      <div className="sh-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label style={row}><span className="lbl">{L('项目名', 'Project name')}</span>
          <input className="field" maxLength={60} autoFocus placeholder={L('比如：11 月报销、稻城出差', 'e.g. November expenses, Daocheng trip')} value={d.name} onChange={(e) => set({ name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) save() }} />
        </label>
        <label style={row}><span className="lbl">{L('购买方（发票抬头）', 'Buyer')}</span>
          <select className="field" value={d.buyer ?? ALL} onChange={(e) => set({ buyer: e.target.value === ALL ? null : e.target.value })}>
            <option value={ALL}>{L('不限', 'Any')}</option>
            {(data?.buyers ?? []).map(([b, n]) => <option key={b} value={b}>{b || L('没读出购买方', 'Buyer not read')}（{n}）</option>)}
            {d.buyer != null && !(data?.buyers ?? []).some(([b]) => b === d.buyer) && <option value={d.buyer}>{d.buyer}</option>}
          </select>
        </label>
        <div style={row}><span className="lbl">{L('开票日期', 'Invoice date')}</span>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input type="date" className="field" style={{ width: 160 }} value={d.from} max={d.to || undefined} onChange={(e) => set({ from: e.target.value })} aria-label={L('从', 'From')} />
            <span style={{ color: 'var(--ter)' }}>~</span>
            <input type="date" className="field" style={{ width: 160 }} value={d.to} min={d.from || undefined} onChange={(e) => set({ to: e.target.value })} aria-label={L('到', 'To')} />
            <button className="btn sm sq" onClick={() => set(month(0))}>{L('本月', 'This month')}</button>
            <button className="btn sm sq" onClick={() => set(month(-1))}>{L('上月', 'Last month')}</button>
            {(d.from || d.to) && <button className="btn link sm" onClick={() => set({ from: '', to: '' })}>{L('不限', 'Any')}</button>}
          </div>
        </div>
        {(s.accounts.length > 1 || d.accounts.length > 0) && (
          <div style={row}><span className="lbl">{L('收到发票的邮箱', 'Mailboxes')}<span style={{ fontWeight: 400, color: 'var(--ter)' }}>{L('（一个都不勾 = 全部邮箱）', ' (none ticked = all)')}</span></span>
            <div className="row" style={{ gap: '6px 14px', flexWrap: 'wrap' }}>
              {s.accounts.map((a) => (
                <label key={a.id} className="row" style={{ gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" className="check" checked={d.accounts.includes(a.id)} onChange={(e) => set({ accounts: e.target.checked ? [...d.accounts, a.id] : d.accounts.filter((x) => x !== a.id) })} />
                  <span className="dot" style={{ background: a.color }} />{a.label || a.email}
                </label>
              ))}
              {gone.length > 0 && (
                <label className="row" style={{ gap: 6, fontSize: 13, cursor: 'pointer', color: 'var(--ter)' }}>
                  <input type="checkbox" className="check" checked onChange={() => set({ accounts: d.accounts.filter((x) => !gone.includes(x)) })} />
                  {L('已经移除的邮箱（勾着它，这个项目就收不到新发票）', 'A removed mailbox (while ticked, nothing new is collected)')}
                </label>
              )}
            </div>
          </div>
        )}
        <label style={row}><span className="lbl">{L('销售方', 'Seller')}</span>
          <select className="field" value={d.seller ?? ALL} onChange={(e) => set({ seller: e.target.value === ALL ? null : e.target.value })}>
            <option value={ALL}>{L('不限', 'Any')}</option>
            {(data?.sellers ?? []).map(([b, n]) => <option key={b} value={b}>{b || L('没读出销售方', 'Seller not read')}（{n}）</option>)}
            {d.seller != null && !(data?.sellers ?? []).some(([b]) => b === d.seller) && <option value={d.seller}>{d.seller}</option>}
          </select>
        </label>
      </div>
      <div className="sh-foot">
        {!!p.id && <button className="btn sq danger" onClick={async () => {
          if (!await ask(L(`删除项目「${p.name}」？只删这个项目，里面的发票还在台账里。`, `Delete the project "${p.name}"? Only the project is removed; its invoices stay in the ledger.`))) return
          try { await api.invoiceProjectDelete(p.id); onDeleted() } catch (e) { s.toast(errText(e), { kind: 'err' }) }
        }}>{L('删除项目', 'Delete project')}</button>}
        <span className="grow" />
        <button className="btn sq" onClick={onClose}>{L('取消', 'Cancel')}</button>
        <button className="btn primary sq" onClick={save}>{p.id ? L('保存', 'Save') : L('建好项目', 'Create')}</button>
      </div>
    </Sheet>
  )
}

function Detail({ r, onChanged, projects, project }: { r: InvoiceRow; onChanged: () => void; projects: InvoiceProject[]; project: InvoiceProject | null }) {
  const s = useApp()
  const menu = useMenu()
  const item = async (pid: number, action: 'add' | 'remove', done: string) => {
    try { await api.invoiceProjectItem(pid, r.id, action); s.toast(done); onChanged() } catch (e) { s.toast(errText(e), { kind: 'err' }) }
  }
  const [d, setD] = useState<InvoiceDetail | null>(null)
  const live = { number: r.number, date: r.date, amount: yuan(r.amount), seller: r.seller, buyer: r.buyer }
  const [v, setV] = useState(live)
  const dirty = useRef<Set<string>>(new Set())
  useEffect(() => { setV((old) => Object.fromEntries(Object.entries(live).map(([k, x]) => [k, dirty.current.has(k) ? old[k as keyof typeof old] : x])) as typeof live) }, [r.number, r.date, r.amount, r.seller, r.buyer])
  useEffect(() => { api.invoiceDetail(r.id).then(setD).catch(() => setD(null)) }, [r.id, r.mails])
  const save = async (k: keyof typeof v, cur: string) => {
    if (!dirty.current.has(k)) return
    dirty.current.delete(k)
    if (v[k] === cur) return
    try { await api.invoiceUpdate(r.id, { [k]: v[k] }); onChanged() } catch (e) { s.toast(errText(e), { kind: 'err' }); setV({ ...v, [k]: cur }) }
  }
  const field = (k: keyof typeof v, label: string, cur: string, ph?: string) => (
    <div className="gr"><span className="lbl" style={{ color: 'var(--sec)', fontSize: 13, flex: 'none' }}>{label}</span>
      <input className={`field inset${cur ? '' : ' need'}`} style={{ flex: 1, minWidth: 0, textAlign: 'right' }} value={v[k]} placeholder={ph ?? L('待核对', 'Check')} onChange={(e) => { dirty.current.add(k); setV({ ...v, [k]: e.target.value }) }} onBlur={() => save(k, cur)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} aria-label={label} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
    </div>
  )
  const openMail = (msgId: number) => s.openMsg(msgId)
  const openFile = (id: number) => api.invoiceOpen(id).catch((e) => s.toast(errText(e), { kind: 'err' }))
  return (
    <>
      <div>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-.02em' }} className="mono">{money(r.amount)}</div>
        <div style={{ fontSize: 13.5, marginTop: 2 }}>{r.seller || L('销售方待核对', 'Seller to check')}</div>
        <div style={{ fontSize: 12, color: r.source === 'pdf' && !r.edited ? 'var(--amber-text)' : 'var(--ter)', marginTop: 6 }}>{sourceText(r)}{r.kind ? ` · ${r.kind}` : ''}</div>
      </div>
      <div className="group sq">
        {field('number', L('发票号', 'Number'), r.number)}
        {field('date', L('开票日期', 'Date'), r.date, '2026-11-03')}
        {field('amount', L('价税合计', 'Total'), yuan(r.amount))}
        {field('seller', L('销售方', 'Seller'), r.seller)}
        {field('buyer', L('购买方', 'Buyer'), r.buyer)}
      </div>
      <div>
        <div className="inv-h">{L('文件', 'Files')}{r.mails > 1 && <span>{L(`（收到过 ${r.mails} 次，只算一张）`, ` (received ${r.mails} times, counted once)`)}</span>}</div>
        <div className="group sq">
          {!d ? <div className="gr" style={{ color: 'var(--ter)', fontSize: 12.5 }}>{L('正在读取…', 'Loading…')}</div> : d.files.filter((x) => x.msgId === d.files[0]?.msgId).map((x) => (
            <div className="gr" key={x.id}>
              <span className="tag">{x.ext.toUpperCase()}</span>
              <span className="truncate" style={{ fontSize: 12.5, flex: 1, minWidth: 0 }} title={x.name}>{x.name}</span>
              {(x.ext === 'pdf' || x.ext === 'ofd') && <button className="btn sm sq" onClick={() => openFile(x.id)}>{L('打开', 'Open')}</button>}
            </div>
          ))}
        </div>
      </div>
      {!!d?.extras.length && (
        <div>
          <div className="inv-h">{L('同一封邮件里的其它材料', 'Other documents in the same email')}<span>{L('（行程单、汇总单这类，导出时一起带上）', ' (itineraries, summaries; included when exporting)')}</span></div>
          <div className="group sq">
            {d.extras.map((x) => (
              <div className="gr" key={x.id}><span className="tag">{x.ext.toUpperCase()}</span><span className="truncate" style={{ fontSize: 12.5, flex: 1, minWidth: 0 }} title={x.name}>{x.name}</span><button className="btn sm sq" onClick={() => openFile(x.id)}>{L('打开', 'Open')}</button></div>
            ))}
          </div>
        </div>
      )}
      {!!d?.mails.length && (
        <div>
          <div className="inv-h">{L('来源邮件', 'Source emails')}</div>
          <div className="group sq">
            {d.mails.map((m) => (
              <button className="gr inv-mail" key={m.msgId} onClick={() => openMail(m.msgId)}>
                <span className="dot" style={{ background: s.accounts.find((a) => a.id === m.accountId)?.color || 'var(--ter)', flex: 'none' }} />
                <span style={{ flex: 1, minWidth: 0 }}><span className="truncate" style={{ display: 'block', fontSize: 12.5 }}>{m.subject || L('（无主题）', '(No subject)')}</span><span className="truncate" style={{ display: 'block', fontSize: 11.5, color: 'var(--ter)' }}>{m.from} · {shortTime(m.date)}</span></span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="row" style={{ gap: 8, marginTop: 'auto', flexWrap: 'wrap' }}>
        {project && !r.hidden && <button className="btn sq" onClick={() => item(project.id, 'remove', L(`已从「${project.name}」移出`, `Removed from "${project.name}"`))}>{L('移出这个项目', 'Remove from project')}</button>}
        {!r.hidden && projects.some((p) => p.id !== project?.id) && (
          <button className="btn sq" onClick={(e) => menu.openBelow(e.currentTarget, projects.filter((p) => p.id !== project?.id).map((p) => ({ label: p.name, run: () => item(p.id, 'add', L(`已加进「${p.name}」`, `Added to "${p.name}"`)) })))}>{L('加进项目…', 'Add to project…')}</button>
        )}
        <button className="btn sq" title={r.hidden ? undefined : L('不要这张：从台账和导出里拿掉，随时能放回来', 'Take it out of the ledger and exports; you can put it back any time')} onClick={async () => { try { await api.invoiceUpdate(r.id, { hidden: !r.hidden }); onChanged() } catch (e) { s.toast(errText(e), { kind: 'err' }) } }}>
          {r.hidden ? L('放回台账', 'Put back') : L('隐藏这张', 'Hide')}
        </button>
      </div>
      {menu.node}
    </>
  )
}

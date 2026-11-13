import { Fragment, useEffect, useRef, useState } from 'react'
import { ask } from '../lib/ask'
import { Icon } from '../icons'
import { rowKey, useApp } from '../store'
import { api, errText, FOCUS_CATS, type Draft, type Folder, type MsgLite } from '../lib/api'
import { dayGroup, shortTime, who } from '../lib/format'
import { Avatar, Empty, Kojoo, Seg, Sheet, TipText, useMenu, type MenuItem } from '../ui'
import { folderName } from './Sidebar'
import { catLabel, L, plural } from '../lib/i18n'

export function laterOptions(): [string, number][] {
  const now = new Date()
  const at = (d: Date, h: number) => { const x = new Date(d); x.setHours(h, 0, 0, 0); return Math.floor(x.getTime() / 1000) }
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1)
  const monday = new Date(now); monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7))
  const opts: [string, number][] = []
  if (now.getHours() < 17) opts.push([L('今天晚些（18:00）', 'Later today (18:00)'), at(now, 18)])
  opts.push([L('明天上午（9:00）', 'Tomorrow morning (9:00)'), at(tomorrow, 9)], [L('下周一（9:00）', 'Next Monday (9:00)'), at(monday, 9)])
  return opts
}

/** 这些邮件都在同一个账号里就返回账号 id（跨账号不能移到某个具体文件夹） */
function sameAccount(ids: number[]): number | null {
  const s = useApp.getState()
  const accs = new Set(ids.map((id) => (s.items.find((x) => x.id === id) ?? (s.open?.id === id ? s.open : undefined))?.accountId))
  const [a] = [...accs]
  return accs.size === 1 && a ? a : null
}

/** 「移动到…」：列出这个账号的文件夹，可以按名字筛 */
export function MovePicker() {
  const s = useApp()
  const [q, setQ] = useState('')
  const pick = s.movePick
  if (!pick) return null
  const close = () => s.set({ movePick: null })
  const cur = new Set(pick.ids.map((id) => s.items.find((x) => x.id === id)?.folderId))
  const list = s.folders.filter((f) => f.accountId === pick.accountId && f.role !== 'drafts' && !cur.has(f.id) && (!q.trim() || f.name.toLowerCase().includes(q.trim().toLowerCase())))
  const go = (f: Folder) => { close(); s.move(pick.ids, `folder:${f.id}`, L(`移到「${f.name}」`, `moved to "${f.name}"`)) }
  return (
    <Sheet onClose={close} label={L('移动到文件夹', 'Move to folder')} className="narrow">
      <div className="sh-head">
        <div className="grow"><h1>{L(`移动 ${pick.ids.length} 封邮件到…`, `Move ${plural(pick.ids.length, '', 'email')} to…`)}</h1></div>
        <button className="tb" aria-label={L('关闭', 'Close')} onClick={close}><Icon name="x" /></button>
      </div>
      <div className="sh-body">
        <input className="field" autoFocus placeholder={L('按名字找文件夹', 'Find a folder by name')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) go(list[0]) }} />
        <div className="group sq" style={{ marginTop: 12, maxHeight: 360, overflowY: 'auto' }}>
          {list.length === 0 ? <div className="gr" style={{ color: 'var(--sec)', fontSize: 13 }}>{L('没有可以移过去的文件夹', 'No folders to move to')}</div> : list.map((f) => (
            <button key={f.id} className="gr" style={{ width: '100%', border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer' }} onClick={() => go(f)}>
              <Icon name="folder" size={15} style={{ color: 'var(--sec)' }} /><span className="lbl grow truncate">{f.name}</span>
              {f.path !== f.name && <span className="mono truncate" style={{ fontSize: 11.5, color: 'var(--ter)', maxWidth: 200 }}>{f.path}</span>}
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  )
}

export function mailMenu(m: MsgLite, ids: number[]): MenuItem[] {
  const s = useApp.getState()
  const open = async (mode: 'reply' | 'replyAll' | 'forward') => {
    try { s.openCompose(mode, await api.get(m.id)) } catch (e) { s.toast(errText(e), { kind: 'err' }) }
  }
  const items: MenuItem[] = []
  if (ids.length === 1) {
    items.push(
      { label: L('回复', 'Reply'), icon: 'reply', key: 'R', run: () => open('reply') },
      { label: L('全部回复', 'Reply all'), icon: 'replyAll', key: 'A', run: () => open('replyAll') },
      { label: L('转发', 'Forward'), icon: 'forward', key: 'F', run: () => open('forward') },
      'sep',
    )
  }
  items.push(
    { label: m.seen ? L('标为未读', 'Mark as unread') : L('标为已读', 'Mark as read'), icon: 'mail', key: 'U', run: () => s.mark(ids, { seen: !m.seen }) },
    { label: m.flagged ? L('取消重点', 'Remove from Important') : L('标为重点', 'Mark as important'), icon: 'flag', key: 'S', run: () => s.mark(ids, { flagged: !m.flagged }) },
    ...laterOptions().map(([label, t]): MenuItem => ({ label: L(`稍后处理：${label}`, `Snooze: ${label}`), icon: 'clock', run: () => s.later(ids, t) })),
    'sep',
  )
  if (m.role !== 'inbox') items.push({ label: L('移回收件箱', 'Move to Inbox'), icon: 'inbox', run: () => s.move(ids, 'inbox', L('移回收件箱', 'moved to Inbox')) })
  if (m.role !== 'archive' && m.role !== 'all') items.push({ label: L('归档', 'Archive'), icon: 'archive', key: 'E', run: () => s.move(ids, 'archive', L('归档', 'archived')) })
  if (m.role === 'inbox' && ids.length === 1 && m.fromAddr) {
    items.push({ label: L(`归档 ${m.fromName || m.fromAddr} 的所有邮件`, `Archive all from ${m.fromName || m.fromAddr}`), icon: 'archive', run: () => s.bulkArchive({ filter: `from:${m.fromAddr}`, view: 'all', accountId: null }, L(`来自 ${m.fromName || m.fromAddr} 的邮件`, `emails from ${m.fromName || m.fromAddr}`)) })
  }
  const acc = sameAccount(ids)
  if (acc) items.push({ label: L('移动到…', 'Move to…'), icon: 'folder', run: () => s.set({ movePick: { ids, accountId: acc } }) })
  if (m.role !== 'junk') items.push({ label: L('标为垃圾邮件', 'Mark as junk'), icon: 'ban', run: () => s.move(ids, 'junk', L('移到垃圾邮件', 'moved to Junk')) })
  if (m.role === 'trash') items.push({ label: L('彻底删除', 'Delete forever'), icon: 'trash', danger: true, run: async () => { if (await ask(L(`彻底删除 ${ids.length} 封邮件？删除后无法恢复。`, `Permanently delete ${plural(ids.length, '', 'email')}? This can't be undone.`))) s.removeForever(ids) } })
  else items.push({ label: L('删除', 'Delete'), icon: 'trash', key: 'Del', run: () => s.move(ids, 'trash', L('删除', 'deleted')) })
  return items
}

export default function MailList() {
  const s = useApp()
  const rowsRef = useRef<HTMLDivElement>(null)
  const menu = useMenu()
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const isDrafts = s.view.kind === 'drafts'
  // 分类页签（AI 整理）：当前视图里有邮件的分类都列出来，常用分类排前面；数字是未读
  const viewAcc = s.view.kind === 'all' || s.view.kind === 'folder' ? s.view.accountId : undefined
  const focus: string[] = viewAcc ? (s.accounts.find((a) => a.id === viewAcc)?.focus ?? []) : FOCUS_CATS.filter((c) => s.accounts.some((a) => a.focus.includes(c)))
  const rank = (c: string) => (focus.includes(c) ? 0 : 1)
  // 常用分类没邮件也常驻（「待办」还包括有没做完待办事项的信，数字里算不到）
  const cats = [...s.cats, ...(s.cats.length ? focus.filter((f) => !s.cats.some((c) => c.cat === f)).map((cat) => ({ cat, total: 0, unread: 0 })) : [])]
    .filter((c) => c.cat !== '其他' || s.filter === 'cat:其他').sort((a, b) => rank(a.cat) - rank(b.cat))
  const curCat = s.filter.startsWith('cat:') ? s.filter.slice(4) : ''
  const tabs: [string, string][] = [['all', L('全部', 'All')], ['unread', L('未读', 'Unread')], ...cats.map((c): [string, string] => [`cat:${c.cat}`, c.unread ? `${catLabel(c.cat)} ${c.unread > 99 ? '99+' : c.unread}` : catLabel(c.cat)])]
  // 选中的分类刚被清空（比如刚整理完）：页签留着，不跳走
  if (curCat && !cats.some((c) => c.cat === curCat)) tabs.push([s.filter, catLabel(curCat)])
  const bulkUnread = s.cats.filter((c) => c.cat === '通知' || c.cat === '订阅').reduce((n, c) => n + c.unread, 0)
  // 只有收件箱里才给「归档」类的整理
  const inInbox = s.view.kind === 'all' || (s.view.kind === 'folder' && s.folders.find((f) => f.id === (s.view as { folderId: number }).folderId)?.role === 'inbox')
  const subsTotal = inInbox ? s.cats.find((c) => c.cat === '订阅')?.total ?? 0 : 0
  const notesTotal = inInbox ? s.cats.find((c) => c.cat === '通知')?.total ?? 0 : 0
  const canTidy = !s.search && (bulkUnread > 0 || subsTotal > 0 || notesTotal > 0)
  const tidyMenu = (el: HTMLElement) => menu.openBelow(el, [
    ...(bulkUnread > 0 ? [{ label: L(`通知和订阅标为已读（${bulkUnread}）`, `Mark notifications & newsletters read (${bulkUnread})`), icon: 'mail', run: () => s.tidy() }] : []),
    ...(subsTotal > 0 ? [{ label: L(`订阅全部归档（${subsTotal}）`, `Archive all newsletters (${subsTotal})`), icon: 'archive', run: () => s.bulkArchive({ filter: 'cat:订阅' }, L('订阅邮件', 'newsletters')) }] : []),
    ...(notesTotal > 0 ? [{ label: L(`通知全部归档（${notesTotal}）`, `Archive all notifications (${notesTotal})`), icon: 'archive', run: () => s.bulkArchive({ filter: 'cat:通知' }, L('通知邮件', 'notifications')) }] : []),
  ])

  useEffect(() => {
    if (!isDrafts) return
    api.drafts().then(setDrafts).catch(() => setDrafts([]))
  }, [isDrafts, s.counts.drafts, s.compose])

  useEffect(() => {
    if (s.selected) rowsRef.current?.querySelector(`[data-id="${s.selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [s.selected])

  const account = (id: number) => s.accounts.find((a) => a.id === id)
  const folder = s.view.kind === 'folder' ? s.folders.find((f) => f.id === (s.view as { folderId: number }).folderId) : undefined
  const title = s.search ? L('搜索结果', 'Search results')
    : s.view.kind === 'all' ? (s.view.accountId ? account(s.view.accountId)?.label || account(s.view.accountId)?.email || L('收件箱', 'Inbox') : L('全部收件箱', 'Inbox'))
    : s.view.kind === 'important' ? L('重点', 'Important') : s.view.kind === 'bills' ? L('账单发票', 'Bills & invoices') : s.view.kind === 'followup' ? L('待跟进', 'Follow up') : s.view.kind === 'later' ? L('稍后处理', 'Snoozed') : s.view.kind === 'sent' ? L('已发送', 'Sent') : s.view.kind === 'drafts' ? L('草稿', 'Drafts')
    : folder ? folderName(folder) : ''
  const unread = s.items.filter((m) => !m.seen).length
  const sub = s.loading ? '' : s.search ? plural(s.total, '封', 'email') : s.view.kind === 'all' && s.filter === 'all' ? (unread ? L(`${s.counts.inboxUnread} 封未读`, `${s.counts.inboxUnread} unread`) : plural(s.total, '封', 'email')) : plural(s.total, '封', 'email')
  const showSender = (m: MsgLite) => (m.role === 'sent' || m.role === 'drafts' ? { name: m.to[0]?.name || '', email: m.to[0]?.email || '' } : { name: m.fromName, email: m.fromAddr })

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) s.loadMore()
  }

  const checked = [...s.checked]
  const bulkBase = s.items.find((m) => m.id === checked[0])

  return (
    <section className="list" aria-label={L('邮件列表', 'Email list')}>
      <div className="list-head">
        <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
          <h1 className="truncate">{title}</h1>
          <span style={{ fontSize: 12.5, color: 'var(--ter)', whiteSpace: 'nowrap' }}>{isDrafts ? plural(drafts?.length ?? 0, '封', 'draft') : sub}</span>
          {canTidy && <button className="tb tidy" style={{ marginLeft: 'auto', alignSelf: 'center' }} aria-label={L('整理', 'Tidy up')} data-tip={L('整理通知和订阅', 'Tidy up notifications and newsletters')} onClick={(e) => tidyMenu(e.currentTarget)}><Icon name="sparkle" />{L('整理', 'Tidy up')}<Icon name="down" size={12} /></button>}
          {!isDrafts && !s.search && folder?.role !== 'drafts' && <button className="tb" style={{ marginLeft: canTidy ? undefined : 'auto', alignSelf: 'center' }} aria-label={L('全部标为已读', 'Mark all as read')} data-tip={L('全部标为已读', 'Mark all as read')} onClick={() => s.markAllRead()}><Icon name="check" /></button>}
          {!s.search && folder && (folder.role === 'trash' || folder.role === 'junk') && (
            <button className="btn sm sq" style={{ alignSelf: 'center' }} onClick={async () => {
              if (!await ask(L(`清空「${folder.name}」？服务器上这个文件夹里的邮件会全部彻底删除（包括没下载到本机的旧邮件），不能恢复。`, `Empty "${folder.name}"? Every email in this folder on the server will be permanently deleted (including older ones not downloaded to this computer). This can't be undone.`))) return
              try { const n = await api.emptyFolder(folder.id); s.toast(n ? L(`已清空 ${n} 封`, `Deleted ${plural(n, '', 'email')}`) : L('已清空', 'Folder emptied')); s.loadList(true) } catch (e) { s.toast(errText(e), { kind: 'err' }) }
            }}>{L('清空', 'Empty')}</button>
          )}
          {!isDrafts && <button className="tb" style={{ alignSelf: 'center', marginLeft: s.search || folder?.role === 'drafts' ? 'auto' : undefined }} aria-label={L('刷新', 'Refresh')} data-tip={L('立即同步', 'Sync now')} onClick={() => { api.syncNow(); s.loadList(true) }}><Icon name="refresh" /></button>}
        </div>
        {checked.length > 0 && bulkBase ? (
          <div className="row" style={{ marginTop: 12, height: 30, padding: '0 4px 0 12px', borderRadius: 8, background: 'var(--invert)', color: 'var(--invert-text)' }}>
            <span className="grow" style={{ fontSize: 12.5, fontWeight: 600 }}>{L(`已选 ${checked.length} 封`, `${checked.length} selected`)}</span>
            <button className="tb" style={{ color: 'inherit', width: 26, height: 26 }} aria-label={L('归档', 'Archive')} data-tip={L('归档', 'Archive')} onClick={() => s.move(checked, 'archive', L('归档', 'archived'))}><Icon name="archive" size={15} /></button>
            <button className="tb" style={{ color: 'inherit', width: 26, height: 26 }} aria-label={L('标为已读', 'Mark as read')} data-tip={L('标为已读', 'Mark as read')} onClick={() => { s.mark(checked, { seen: true }); s.set({ checked: new Set() }) }}><Icon name="mail" size={15} /></button>
            {sameAccount(checked) && <button className="tb" style={{ color: 'inherit', width: 26, height: 26 }} aria-label={L('移动到', 'Move to')} data-tip={L('移动到…', 'Move to…')} onClick={() => s.set({ movePick: { ids: checked, accountId: sameAccount(checked)! } })}><Icon name="folder" size={15} /></button>}
            <button className="tb" style={{ color: 'inherit', width: 26, height: 26 }} aria-label={L('删除', 'Delete')} data-tip={L('删除', 'Delete')} onClick={() => s.move(checked, 'trash', L('删除', 'deleted'))}><Icon name="trash" size={15} /></button>
            <button className="tb" style={{ color: 'inherit', width: 26, height: 26 }} aria-label={L('取消选择', 'Clear selection')} data-tip={L('取消选择', 'Clear selection')} onClick={() => s.set({ checked: new Set() })}><Icon name="x" size={15} /></button>
          </div>
        ) : !isDrafts && !s.search && (
          <div className="tabs-scroll" style={{ marginTop: 12 }}>
            <Seg value={s.filter} onChange={s.setFilter} options={tabs} />
          </div>
        )}
      </div>

      <div className="rows" ref={rowsRef} onScroll={onScroll}>
        {s.search && s.aiConfigured && <AskCard />}
        {isDrafts ? (
          drafts && drafts.length === 0 ? <Empty icon="draft" title={L('没有草稿', 'No drafts')} sub={L('写到一半关掉的邮件会自动存在这里', 'Emails you close before sending are saved here automatically')} /> : (drafts || []).map((d) => (
            <div key={d.id} className="mrow" onClick={() => s.openCompose('draft', null, { draftId: d.id, draft: { ...d, accountId: d.accountId ?? s.accounts[0]?.id, html: '' } })}>
              <Avatar name={d.to[0]?.name || ''} email={d.to[0]?.email || '?'} />
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ alignItems: 'baseline', gap: 6 }}><span className="who truncate">{d.to.length ? L(`致 ${d.to.map((a) => a.name || a.email).join('、')}`, `To ${d.to.map((a) => a.name || a.email).join(', ')}`) : L('（还没填收件人）', '(No recipients yet)')}</span><span className="time">{shortTime(d.updated)}</span></div>
                <div className="subj truncate">{d.subject || L('（无主题）', '(No subject)')}</div>
                <div className="prev">{d.body.slice(0, 120) || ' '}</div>
              </div>
            </div>
          ))
        ) : s.loading && s.items.length === 0 ? (
          [0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="mrow" style={{ cursor: 'default' }}>
              <div className="skel" style={{ width: 36, height: 36 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 3 }}>
                <div className="skel" style={{ height: 10, width: `${40 + i * 6}%` }} />
                <div className="skel" style={{ height: 9, width: '80%' }} />
                <div className="skel" style={{ height: 9, width: '60%' }} />
              </div>
            </div>
          ))
        ) : s.items.length === 0 ? (
          s.search ? <Empty icon="search" title={L(`没找到「${s.search}」`, `Nothing found for "${s.search}"`)} sub={L('搜的是所有账号的标题、发件人和正文', 'Searched subjects, senders and bodies in all accounts')} />
            : s.filter !== 'all' ? <Empty icon="inbox" title={L('这里是空的', 'Nothing here')} sub={L('换个筛选看看', 'Try another filter')} />
            : s.view.kind === 'all' ? <Empty icon="todo" title={L('都处理完了', 'All caught up')} sub={L('新邮件会自动出现在这里', 'New emails will show up here')} />
            : <Empty icon="inbox" title={L('这里是空的', 'Nothing here')} />
        ) : (
          s.items.map((m, i) => {
            const g = s.view.kind === 'sent' || s.search ? null : dayGroup(m.date)
            const showG = g && (i === 0 || dayGroup(s.items[i - 1].date) !== g)
            const acc = account(m.accountId)
            const p = showSender(m)
            const isChecked = s.checked.has(m.id)
            // 按会话显示：这一行是一串会话（不止一封）时，显示参与的人、封数，未读 / 附件 / 重点按整串算
            const th = m.thread && m.thread.count > 1 ? m.thread : null
            const unreadRow = th ? th.unread > 0 : !m.seen && m.role !== 'sent'
            const selRow = s.selected === m.id || (!!s.threadKey && rowKey(m) === s.threadKey)
            return (
              <Fragment key={m.id}>
                {showG && <div className="group-h">{g}</div>}
                <div
                  data-id={m.id}
                  className={`mrow${selRow ? ' sel' : ''}${unreadRow ? ' unread' : ''}${isChecked ? ' checked' : ''}`}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey || e.shiftKey || s.checked.size) { s.toggleCheck(m.id); return }
                    s.select(m.id)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    const ids = s.checked.has(m.id) ? checked : [m.id]
                    menu.openAt(e.clientX, e.clientY, mailMenu(m, ids))
                  }}
                >
                  {unreadRow && <span className="udot" />}
                  <span onClick={(e) => { e.stopPropagation(); s.toggleCheck(m.id) }} title={L('选择', 'Select')}>
                    {isChecked
                      ? <span className="avatar" style={{ background: 'var(--navy)', color: '#fff' }}><Icon name="check" size={18} /></span>
                      : <Avatar name={p.name} email={p.email} badge={s.accounts.length > 1 ? acc?.color : undefined} />}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ alignItems: 'baseline', gap: 6 }}>
                      <span className="who truncate">{th ? th.who.join(L('、', ', ')) : m.role === 'sent' ? L(`致 ${p.name || p.email}`, `To ${p.name || p.email}`) : who(m)}</span>
                      {th && <span className="tcount" title={L(`这个会话有 ${th.count} 封`, `${th.count} emails in this conversation`)}>{th.count}</span>}
                      {(th ? th.hasAtt : m.hasAtt) && <Icon name="clip" size={13} style={{ color: 'var(--ter)', alignSelf: 'center' }} />}
                      {(th ? th.flagged : m.flagged) && <Icon name="flag" size={13} className="flag" style={{ alignSelf: 'center' }} />}
                      <span className="time">{shortTime(m.date)}</span>
                    </div>
                    <div className="subj truncate">{m.subject || L('（无主题）', '(No subject)')}</div>
                    <div className="prev">{m.aiSummary || m.snippet || ' '}</div>
                    {s.view.kind === 'followup' && !s.search && (
                      <div className="tags"><span className="tag amber">{((n) => L(`发出 ${n} 天，还没回`, `No reply in ${plural(n, '', 'day')}`))(Math.max(1, Math.floor((Date.now() / 1000 - m.date) / 86400)))}</span></div>
                    )}
                    {(m.aiCategory === '询盘' || m.aiPriority === 'high' || m.openTodos > 0 || m.later) && (
                      <div className="tags">
                        {m.aiCategory === '询盘' && <span className="tag hot">{L('询盘', 'Inquiry')}{m.aiPriority === 'high' ? L(' · 高优先', ' · High') : ''}</span>}
                        {m.aiCategory !== '询盘' && m.aiPriority === 'high' && <span className="tag hot">{L('高优先', 'High priority')}</span>}
                        {m.openTodos > 0 && <span className="tag navy">{plural(m.openTodos, '项待办', 'to-do')}</span>}
                        {m.later && m.later > Date.now() / 1000 && <span className="tag amber">{L('稍后', 'Later')} · {shortTime(m.later)}</span>}
                      </div>
                    )}
                  </div>
                </div>
              </Fragment>
            )
          })
        )}
        {s.loadingMore && <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}><div className="skel" style={{ width: 80, height: 8 }} /></div>}
      </div>
      {menu.node}
    </section>
  )
}

/** 问邮箱：搜索结果上方。像提问的搜索会自动问；普通搜索给一个「问 AI」的入口 */
function AskCard() {
  const s = useApp()
  const a = s.ask && s.ask.q === s.search ? s.ask : null
  if (!a) {
    return (
      <button className="ask-try" onClick={() => s.askAi(s.search)}>
        <Icon name="sparkle" size={15} /><TipText className="grow truncate">{L(`让 AI 从邮件里找答案：「${s.search}」`, `Ask AI to answer from your emails: "${s.search}"`)}</TipText><Icon name="right" size={13} />
      </button>
    )
  }
  const src = a.out?.sources ?? []
  const open = (n: number) => { const x = src.find((y) => y.n === n); if (x) s.openMsg(x.id) }
  // 回答里的 [#3]、[#1, #3] 换成可点的小标签
  const body = (a.out?.answer ?? '').split(/(\[#\d+(?:\s*[,，、]\s*#?\d+)*\])/g).map((p, i) => {
    if (!/^\[#\d/.test(p)) return p
    return (p.match(/\d+/g) || []).map(Number).filter((n) => src.some((x) => x.n === n)).map((n) => (
      <button key={`${i}-${n}`} className="ask-cite" onClick={() => open(n)} title={L('打开这封邮件', 'Open this email')}>{n}</button>
    ))
  })
  return (
    <div className="ai-card sq ask-card">
      <div className="ai-strip">
        {a.busy ? <span style={{ color: '#F2A487', display: 'inline-flex' }}><Kojoo width={26} stroke={8} /></span> : <Icon name="sparkle" style={{ color: '#F2A487' }} />}
        <span className="t">{L('问邮箱', 'Ask your mailbox')}</span>
        <span className="s truncate">{a.busy ? L('正在翻邮件…', 'Searching your emails…') : a.out?.keywords.length ? L(`搜了：${a.out.keywords.join('、')}`, `Searched: ${a.out.keywords.join(', ')}`) : ''}</span>
        {!a.busy && <button className="tb" aria-label={L('重新问', 'Ask again')} data-tip={L('重新问一次', 'Ask again')} onClick={() => s.askAi(a.q)}><Icon name="refresh" size={15} /></button>}
      </div>
      {a.busy ? (
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}><div className="skel" style={{ height: 9, width: '90%' }} /><div className="skel" style={{ height: 9, width: '65%' }} /></div>
      ) : a.err ? (
        <div className="ask-body" style={{ paddingBottom: 12 }}>{L('没问成功：', "Couldn't get an answer: ")}{a.err.slice(0, 160)}</div>
      ) : (
        <>
          <div className="ask-body">{body}</div>
          {src.length > 0 && (
            <div className="ask-src">
              {src.map((x) => (
                <button key={x.n} onClick={() => s.openMsg(x.id)}>
                  <span className="n">{x.n}</span><span className="truncate">{x.who} · {x.subject || L('（无主题）', '(No subject)')}</span><span className="t">{shortTime(x.date)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

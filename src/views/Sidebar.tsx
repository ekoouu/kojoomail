import { useState } from 'react'
import { Icon } from '../icons'
import { useApp, type View } from '../store'
import { keyText } from '../lib/platform'
import type { Folder } from '../lib/api'
import { L } from '../lib/i18n'

const ROLE_NAME: Record<string, string> = { inbox: L('收件箱', 'Inbox'), sent: L('已发送', 'Sent'), drafts: L('草稿', 'Drafts'), archive: L('归档', 'Archive'), junk: L('垃圾邮件', 'Junk'), trash: L('已删除', 'Trash'), all: L('所有邮件', 'All mail'), starred: L('已加星标', 'Starred') }
const ROLE_ICON: Record<string, string> = { inbox: 'inbox', sent: 'send', drafts: 'draft', archive: 'archive', junk: 'ban', trash: 'trash', all: 'mail', starred: 'flag' }
export const folderName = (f: Folder) => ROLE_NAME[f.role] || f.name

export default function Sidebar() {
  const s = useApp()
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const isView = (k: View['kind'], extra?: (v: View) => boolean) => s.page === 'mail' && !s.search && s.view.kind === k && (!extra || extra(s.view))

  const nav = (on: boolean, icon: string, label: string, count: number | null, click: () => void, title?: string) => (
    <button className={`nav sq${on ? ' on' : ''}`} onClick={click} aria-current={on ? 'page' : undefined} title={title}>
      <Icon name={icon} />{label}{count ? <span className="cnt">{count > 999 ? '999+' : count}</span> : null}
    </button>
  )

  const settings = s.settings
  const used = s.aiUsedToday
  const limit = settings?.aiDailyLimit || 200

  return (
    <nav className="side" aria-label={L('导航', 'Navigation')}>
      <div className="side-scroll">
      <div className="h">{L('智能视图', 'Smart views')}</div>
      {nav(s.page === 'digest', 'sparkle', L('今日简报', "Today's digest"), null, () => s.set({ page: 'digest', selected: null, open: null }), L('今天要回的、要付的、要跟进的，一页看完', 'What to reply to, pay and follow up on today, on one page'))}
      {nav(isView('all', (v) => v.kind === 'all' && !v.accountId), 'inbox', L('全部收件箱', 'All inboxes'), s.counts.inboxUnread, () => s.go({ kind: 'all' }))}
      {nav(isView('important'), 'flag', L('重点', 'Important'), s.counts.important, () => s.go({ kind: 'important' }), L('标了重点的，和 AI 判断需要尽快处理的', 'Emails you flagged, plus the ones AI thinks need attention soon'))}
      {nav(s.page === 'todo', 'todo', L('待办', 'To-dos'), s.counts.todos, () => s.set({ page: 'todo', selected: null }))}
      {nav(isView('followup'), 'wait', L('待跟进', 'Follow up'), s.counts.followups, () => s.go({ kind: 'followup' }), L('你发出去 3 天以上、对方还没回的邮件', "Emails you sent over 3 days ago that haven't been answered"))}
      {nav(s.page === 'invoices', 'receipt', L('发票', 'Invoices'), null, () => s.set({ page: 'invoices', selected: null, open: null }), L('邮件附件里的发票：一张一行，重复收到的只算一张，可以按购买方、月份筛出来导出', 'Invoices attached to your emails: one row each, duplicates counted once; filter by buyer or month and export'))}
      {nav(isView('later'), 'clock', L('稍后处理', 'Snoozed'), s.counts.later, () => s.go({ kind: 'later' }))}
      {nav(isView('drafts'), 'draft', L('草稿', 'Drafts'), s.counts.drafts, () => s.go({ kind: 'drafts' }))}
      {nav(isView('sent'), 'send', L('已发送', 'Sent'), null, () => s.go({ kind: 'sent' }))}

      <div className="h gap" style={{ display: 'flex', alignItems: 'center' }}>
        {L('账号', 'Accounts')}
        <button className="tb" style={{ width: 22, height: 22, marginLeft: 'auto', marginRight: -4 }} aria-label={L('添加账号', 'Add account')} data-tip={L('添加账号', 'Add account')} onClick={() => s.set({ addAccount: 'pick' })}><Icon name="plus" size={14} /></button>
      </div>
      {s.accounts.map((a) => {
        const st = s.status[a.id]
        const folders = s.folders.filter((f) => f.accountId === a.id)
        const inbox = folders.find((f) => f.role === 'inbox')
        const on = isView('all', (v) => v.kind === 'all' && v.accountId === a.id)
        const err = st?.state === 'error'
        const off = st?.state === 'offline'
        const two = err || off
        const expanded = !!open[a.id]
        return (
          <div key={a.id}>
            <button className={`nav sq${on ? ' on' : ''}`} style={two ? { height: 'auto', minHeight: 30, padding: '6px 10px', alignItems: 'flex-start' } : undefined}
              onClick={() => (err ? s.set({ repairAccount: a.id }) : s.go({ kind: 'all', accountId: a.id }))} title={a.email}>
              <span className={`chev${expanded ? ' open' : ''}`} style={two ? { marginTop: 2 } : undefined} role="button" aria-label={expanded ? L('收起文件夹', 'Collapse folders') : L('展开文件夹', 'Expand folders')}
                onClick={(e) => { e.stopPropagation(); setOpen({ ...open, [a.id]: !expanded }) }}>
                <Icon name="right" size={12} />
              </span>
              <span className="dot" style={{ background: a.color, margin: two ? '5px 5px 0' : '0 5px' }} />
              <span className="grow truncate" style={{ lineHeight: two ? 1.35 : undefined }}>
                {a.label || a.email}
                {err && <span className="err-line">{st.errorKind === 'auth' ? L('授权失效，点此修复', 'Sign-in expired. Click to fix') : st.errorKind === 'store' ? L('读不到保存的密码，点此查看', 'Can\'t read the saved password. Click to see') : L('连接出错，点此查看', 'Connection error. Click to see')}</span>}
                {off && <span className="off-line">{L('网络断开，正在重连', 'Offline, reconnecting')}</span>}
              </span>
              {err ? <Icon name="alert" size={15} style={{ color: 'var(--accent-text)', marginTop: 2 }} /> : inbox && inbox.unread > 0 ? <span className="cnt">{inbox.unread}</span> : null}
            </button>
            {expanded && folders.map((f) => (
              <button key={f.id} className={`nav sub sq${isView('folder', (v) => v.kind === 'folder' && v.folderId === f.id) ? ' on' : ''}`} onClick={() => s.go({ kind: 'folder', folderId: f.id, accountId: a.id })}>
                <Icon name={ROLE_ICON[f.role] || 'folder'} size={15} /><span className="grow truncate">{folderName(f)}</span>
                {f.unread > 0 && f.role !== 'sent' && f.role !== 'trash' && <span className="cnt">{f.unread}</span>}
              </button>
            ))}
          </div>
        )
      })}
      </div>

      <div className="foot">
        {s.aiConfigured && (
          <div className="usage">
            <div className="row" style={{ justifyContent: 'space-between', fontSize: 11, color: 'var(--sec)' }}><span>{L('今日 AI 分析', 'AI analyses today')}</span><span className="num">{used} / {limit}</span></div>
            <div className="bar"><i style={{ width: `${Math.min(100, (used / Math.max(1, limit)) * 100)}%` }} /></div>
          </div>
        )}
        <div className="me">
          <span className="avatar sm" style={{ background: 'var(--invert)', color: 'var(--invert-text)' }}>{(s.accounts[0]?.displayName || s.accounts[0]?.email || 'K').slice(0, 1).toUpperCase()}</span>
          <div className="grow truncate" style={{ fontSize: 12.5, fontWeight: 500 }}>{s.accounts[0]?.displayName || L('我的邮箱', 'My mail')}</div>
          <button className="tb" aria-label={L('设置', 'Settings')} data-tip={keyText(L('设置  Ctrl ,', 'Settings  Ctrl ,'))} data-tip-pos="up" onClick={() => s.set({ page: 'settings', settingsTab: 'general' })}><Icon name="gear" /></button>
        </div>
      </div>
    </nav>
  )
}

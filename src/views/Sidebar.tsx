import { useState } from 'react'
import { ask } from '../lib/ask'
import { Icon } from '../icons'
import { useApp, type View } from '../store'
import { keyText } from '../lib/platform'
import { api, errText, type Folder } from '../lib/api'
import { Sheet, useMenu, type MenuItem } from '../ui'
import { L } from '../lib/i18n'

const ROLE_NAME: Record<string, string> = { inbox: L('收件箱', 'Inbox'), sent: L('已发送', 'Sent'), drafts: L('草稿', 'Drafts'), archive: L('归档', 'Archive'), junk: L('垃圾邮件', 'Junk'), trash: L('已删除', 'Trash'), all: L('所有邮件', 'All mail'), starred: L('已加星标', 'Starred') }
const ROLE_ICON: Record<string, string> = { inbox: 'inbox', sent: 'send', drafts: 'draft', archive: 'archive', junk: 'ban', trash: 'trash', all: 'mail', starred: 'flag' }
export const folderName = (f: Folder) => ROLE_NAME[f.role] || f.name

type FolderEdit = { accountId: number; parent?: Folder; folder?: Folder }

function FolderSheet({ edit, onClose }: { edit: FolderEdit; onClose: () => void }) {
  const s = useApp()
  const [name, setName] = useState(edit.folder?.name ?? '')
  const [busy, setBusy] = useState(false)
  const rename = !!edit.folder
  const submit = async () => {
    const value = name.trim()
    if (!value || busy) return
    setBusy(true)
    try {
      if (edit.folder) await api.renameFolder(edit.folder.id, value)
      else await api.createFolder(edit.accountId, value, edit.parent?.id ?? null)
      await s.refreshMeta()
      s.toast(rename ? L('文件夹已重命名', 'Folder renamed') : L('文件夹已创建', 'Folder created'))
      onClose()
    } catch (e) {
      s.toast(errText(e), { kind: 'err' })
      setBusy(false)
    }
  }
  const parent = edit.parent ? folderName(edit.parent) : null
  return (
    <Sheet onClose={onClose} label={rename ? L('重命名文件夹', 'Rename folder') : L('新建文件夹', 'New folder')} className="narrow">
      <div className="sh-head">
        <div className="grow">
          <h1>{rename ? L('重命名文件夹', 'Rename folder') : parent ? L(`在「${parent}」中新建子文件夹`, `New subfolder in "${parent}"`) : L('新建文件夹', 'New folder')}</h1>
        </div>
        <button className="tb" aria-label={L('关闭', 'Close')} onClick={onClose}><Icon name="x" /></button>
      </div>
      <div className="sh-body">
        <label className="label" htmlFor="folder-name">{L('名称', 'Name')}</label>
        <input id="folder-name" className="field" autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }} placeholder={L('例如：项目、账单、客户', 'e.g. Projects, Bills, Clients')} />
      </div>
      <div className="sh-foot" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" disabled={busy} onClick={onClose}>{L('取消', 'Cancel')}</button>
        <button className="btn primary" disabled={busy || !name.trim()} onClick={submit}>{busy ? L('正在保存…', 'Saving…') : rename ? L('保存', 'Save') : L('创建', 'Create')}</button>
      </div>
    </Sheet>
  )
}

export default function Sidebar() {
  const s = useApp()
  const menu = useMenu()
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const [folderEdit, setFolderEdit] = useState<FolderEdit | null>(null)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const isView = (k: View['kind'], extra?: (v: View) => boolean) => s.page === 'mail' && !s.search && s.view.kind === k && (!extra || extra(s.view))

  const nav = (on: boolean, icon: string, label: string, count: number | null, click: () => void, title?: string) => (
    <button className={`nav sq${on ? ' on' : ''}`} onClick={click} aria-current={on ? 'page' : undefined} title={title}>
      <Icon name={icon} />{label}{count ? <span className="cnt">{count > 999 ? '999+' : count}</span> : null}
    </button>
  )

  const folderMenu = (e: React.MouseEvent, accountId: number, f: Folder) => {
    e.preventDefault()
    const items: MenuItem[] = [
      { label: L('新建子文件夹', 'New subfolder'), icon: 'plus', run: () => setFolderEdit({ accountId, parent: f }) },
    ]
    if (!f.role) {
      items.push(
        { label: L('重命名', 'Rename'), icon: 'pen', run: () => setFolderEdit({ accountId, folder: f }) },
        'sep',
        { label: L('删除文件夹', 'Delete folder'), icon: 'trash', danger: true, run: async () => {
          if (!await ask(L(`删除文件夹「${folderName(f)}」？其中的邮件会从服务器删除，无法撤销。`, `Delete folder "${folderName(f)}"? Messages in it will be removed from the server and this can't be undone.`))) return
          try {
            await api.deleteFolder(f.id)
            if (s.view.kind === 'folder' && s.view.folderId === f.id) s.go({ kind: 'all', accountId })
            else await s.refreshMeta()
            s.toast(L('文件夹已删除', 'Folder deleted'))
          } catch (err) { s.toast(errText(err), { kind: 'err' }) }
        } },
      )
    }
    menu.openAt(e.clientX, e.clientY, items)
  }

  const parseDragIds = (e: React.DragEvent) => {
    try {
      const ids = JSON.parse(e.dataTransfer.getData('application/x-kojoomail-ids'))
      return Array.isArray(ids) ? ids.filter((x): x is number => Number.isInteger(x)) : []
    } catch { return [] }
  }

  const dropMail = (e: React.DragEvent, f: Folder) => {
    e.preventDefault()
    setDropTarget(null)
    if (f.role === 'drafts') return
    const ids = parseDragIds(e)
    if (!ids.length) return
    const accounts = new Set(ids.map((id) => s.items.find((m) => m.id === id)?.accountId).filter((x): x is number => !!x))
    const hasUnloaded = ids.some((id) => !s.items.some((m) => m.id === id))
    const scoped = s.view.kind === 'folder' ? s.view.accountId : s.view.kind === 'all' ? s.view.accountId : undefined
    if ((hasUnloaded && !scoped) || accounts.size > 1 || (accounts.size === 1 && !accounts.has(f.accountId)) || (accounts.size === 0 && scoped !== f.accountId)) {
      s.toast(L('跨账号不能直接拖到文件夹，请先选择同一账号的邮件', 'Messages can only be dragged to a folder in the same account'), { kind: 'err' })
      return
    }
    if (ids.every((id) => s.items.find((m) => m.id === id)?.folderId === f.id)) return
    s.move(ids, `folder:${f.id}`, L(`移到「${folderName(f)}」`, `moved to "${folderName(f)}"`))
  }

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
      {nav(isView('bills'), 'receipt', L('账单发票', 'Bills & invoices'), s.counts.bills, () => s.go({ kind: 'bills' }), L('AI 认出来的账单、发票、付款和扣费提醒，加上你自己建的「发票」文件夹（各账号合在一起）', 'Bills, invoices and payment notices recognized by AI, plus your own "Invoices" folders (all accounts together)'))}
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
        const expanded = !!open[a.id]
        return (
          <div key={a.id}>
            <button className={`nav sq${on ? ' on' : ''}`} style={err ? { height: 'auto', minHeight: 30, padding: '6px 10px', alignItems: 'flex-start' } : undefined}
              onClick={() => (err ? s.set({ repairAccount: a.id }) : s.go({ kind: 'all', accountId: a.id }))} title={a.email}
              onContextMenu={(e) => { e.preventDefault(); menu.openAt(e.clientX, e.clientY, [{ label: L('新建文件夹', 'New folder'), icon: 'plus', run: () => setFolderEdit({ accountId: a.id }) }]) }}>
              <span className={`chev${expanded ? ' open' : ''}`} style={err ? { marginTop: 2 } : undefined} role="button" aria-label={expanded ? L('收起文件夹', 'Collapse folders') : L('展开文件夹', 'Expand folders')}
                onClick={(e) => { e.stopPropagation(); setOpen({ ...open, [a.id]: !expanded }) }}>
                <Icon name="right" size={12} />
              </span>
              <span className="dot" style={{ background: a.color, margin: err ? '5px 5px 0' : '0 5px' }} />
              <span className="grow truncate" style={{ lineHeight: err ? 1.35 : undefined }}>
                {a.label || a.email}
                {err && <span className="err-line">{st.errorKind === 'auth' ? L('授权失效，点此修复', 'Sign-in expired. Click to fix') : L('连接出错，点此查看', 'Connection error. Click to see')}</span>}
              </span>
              {err ? <Icon name="alert" size={15} style={{ color: 'var(--accent-text)', marginTop: 2 }} /> : inbox && inbox.unread > 0 ? <span className="cnt">{inbox.unread}</span> : null}
            </button>
            {expanded && <>
              {folders.map((f) => (
                <button key={f.id}
                  className={`nav sub sq${isView('folder', (v) => v.kind === 'folder' && v.folderId === f.id) ? ' on' : ''}${dropTarget === f.id ? ' drop-target' : ''}`}
                  onClick={() => s.go({ kind: 'folder', folderId: f.id, accountId: a.id })}
                  onContextMenu={(e) => folderMenu(e, a.id, f)}
                  onDragOver={(e) => { if (f.role !== 'drafts') { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTarget(f.id) } }}
                  onDragLeave={() => { if (dropTarget === f.id) setDropTarget(null) }}
                  onDrop={(e) => dropMail(e, f)}
                  title={f.path}>
                  <Icon name={ROLE_ICON[f.role] || 'folder'} size={15} /><span className="grow truncate">{folderName(f)}</span>
                  {f.unread > 0 && f.role !== 'sent' && f.role !== 'trash' && <span className="cnt">{f.unread}</span>}
                </button>
              ))}
              <button className="nav sub add-folder sq" onClick={() => setFolderEdit({ accountId: a.id })}>
                <Icon name="plus" size={14} /><span>{L('新建文件夹', 'New folder')}</span>
              </button>
            </>}
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
      {menu.node}
      {folderEdit && <FolderSheet key={`${folderEdit.accountId}:${folderEdit.parent?.id ?? 0}:${folderEdit.folder?.id ?? 0}`} edit={folderEdit} onClose={() => setFolderEdit(null)} />}
    </nav>
  )
}

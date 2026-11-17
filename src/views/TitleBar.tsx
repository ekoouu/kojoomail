import { useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Icon } from '../icons'
import { useApp } from '../store'
import { Kojoo } from '../ui'
import { IS_MAC, keyText } from '../lib/platform'
import iconSmall from '../assets/app-icon-22@2x.png'
import { L } from '../lib/i18n'

export default function TitleBar({ searchRef }: { searchRef?: React.RefObject<HTMLInputElement> }) {
  const accounts = useApp((s) => s.accounts)
  const status = useApp((s) => s.status)
  const search = useApp((s) => s.search)
  const doSearch = useApp((s) => s.doSearch)
  const openCompose = useApp((s) => s.openCompose)
  const set = useApp((s) => s.set)
  const [q, setQ] = useState('')
  const [maxed, setMaxed] = useState(false)
  const localRef = useRef<HTMLInputElement>(null)
  const ref = searchRef || localRef
  const win = getCurrentWindow()

  useEffect(() => { if (!search) setQ('') }, [search])
  useEffect(() => {
    win.isMaximized().then(setMaxed).catch(() => {})
    const un = win.onResized(() => win.isMaximized().then(setMaxed).catch(() => {}))
    return () => { un.then((f) => f()) }
  }, [])

  const list = accounts.map((a) => status[a.id])
  const errs = accounts.filter((a) => status[a.id]?.state === 'error')
  const syncing = list.some((s) => s && (s.state === 'syncing' || s.state === 'connecting'))
  const offline = list.filter((s) => s?.state === 'offline').length
  const ok = accounts.length - errs.length - offline

  let sync: React.ReactNode = null
  if (accounts.length) {
    if (errs.length) {
      sync = (
        <button className="sync" style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0 }} onClick={() => set({ repairAccount: errs[0].id })} title={L('点击修复', 'Click to fix')}>
          <span className="dot" style={{ background: '#A86A00', width: 6, height: 6 }} />{L(`${ok} 个账号已同步 · ${errs.length} 个需要处理`, `${ok} synced · ${errs.length} need attention`)}
        </button>
      )
    } else if (syncing) {
      sync = <span className="sync"><span style={{ color: 'var(--ink)', display: 'inline-flex' }}><Kojoo width={30} stroke={7} /></span>{L('正在同步', 'Syncing')}</span>
    } else if (offline) {
      sync = <span className="sync"><span className="dot" style={{ background: 'var(--ter)', width: 6, height: 6 }} />{L('网络断开，正在重连', 'Offline, reconnecting')}</span>
    } else {
      sync = <span className="sync"><span className="dot" style={{ background: 'var(--green)', width: 6, height: 6 }} />{L(`${accounts.length} 个账号已同步`, accounts.length === 1 ? '1 account synced' : `${accounts.length} accounts synced`)}</span>
    }
  }

  return (
    <div className={`titlebar${IS_MAC ? ' mac' : ''}`} data-tauri-drag-region>
      <img className="logo" src={iconSmall} alt="" data-tauri-drag-region />
      <div className="name" data-tauri-drag-region>Kojoo Mail</div>
      {sync}
      {accounts.length > 0 && (
        <button className="tb" aria-label={L('写邮件', 'New email')} data-tip={L('写邮件  C', 'New email  C')} onClick={() => openCompose('new')} style={{ color: 'var(--ink-2)', marginLeft: 2 }}><Icon name="compose" /></button>
      )}
      {accounts.length > 0 ? (
        <form className="search sq" onSubmit={(e) => { e.preventDefault(); doSearch(q) }}>
          <Icon name="search" size={16} />
          <input ref={ref} autoCapitalize="off" autoCorrect="off" spellCheck={false} value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('搜索邮件、联系人、询盘编号', 'Search mail, contacts, order numbers')} aria-label={L('搜索', 'Search')}
            onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); if (search) doSearch(''); (e.target as HTMLInputElement).blur() } }} />
          {q || search ? (
            <button type="button" className="tb" style={{ width: 22, height: 22 }} aria-label={L('清除搜索', 'Clear search')} onClick={() => { setQ(''); doSearch('') }}><Icon name="x" size={13} /></button>
          ) : <span className="kbd">{keyText('Ctrl K')}</span>}
        </form>
      ) : <div style={{ flex: 1 }} data-tauri-drag-region />}
      {!IS_MAC && (
        <div className="winbtns">
          <button aria-label={L('最小化', 'Minimize')} onClick={() => win.minimize()}><Icon name="minus" /></button>
          <button aria-label={maxed ? L('还原', 'Restore') : L('最大化', 'Maximize')} onClick={() => win.toggleMaximize()}><Icon name={maxed ? 'restore' : 'max'} /></button>
          <button aria-label={L('关闭', 'Close')} className="close" onClick={() => win.close()}><Icon name="x" /></button>
        </div>
      )}
    </div>
  )
}

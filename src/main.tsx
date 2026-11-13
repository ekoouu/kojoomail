// 界面语言要最先确定：别的模块里有按语言生成的常量
import './lib/i18n'
import React, { useEffect, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import './styles.css'
import { api, on, type Status } from './lib/api'
import { curRow, useApp } from './store'
import { Loader, Toasts, isTyping } from './ui'
import { IS_MAC } from './lib/platform'
import TitleBar from './views/TitleBar'
import Sidebar from './views/Sidebar'
import MailList, { MovePicker } from './views/MailList'
import Reader from './views/Reader'
import Compose from './views/Compose'
import TodoPage from './views/Todo'
import DigestPage from './views/Digest'
import SettingsPage from './views/Settings'
import Welcome from './views/Welcome'
import { AddAccount, RepairAccount } from './views/AccountSheets'
import { GuideSheet } from './views/Guide'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { L } from './lib/i18n'

// 后端开了磨砂玻璃（Windows 11 亚克力）时设的标记：样式据此把窗口底换成透明
if ((window as { __KJM_GLASS__?: boolean }).__KJM_GLASS__) document.documentElement.dataset.glass = '1'

function useTheme() {
  const st = useApp((s) => s.settings)
  useEffect(() => {
    if (!st) return
    const root = document.documentElement
    const apply = () => {
      const dark = st.theme === 'dark' || (st.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
      root.dataset.theme = dark ? 'dark' : 'light'
    }
    // 磨砂玻璃的深浅跟窗口主题走：软件里选了深色/浅色时要告诉窗口，否则跟系统
    if (root.dataset.glass) getCurrentWindow().setTheme(st.theme === 'system' ? null : st.theme).catch(() => {})
    apply()
    root.dataset.density = st.density
    root.dataset.serif = st.serifTitles ? '1' : '0'
    root.style.setProperty('--body-size', `${st.fontSize}px`)
    const mq = matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [st?.theme, st?.density, st?.serifTitles, st?.fontSize])
}

function useBackendEvents() {
  useEffect(() => {
    // 邮件变化、AI 出结果：合并 400ms 内的多次通知，只刷新一次列表和计数
    let t: ReturnType<typeof setTimeout> | null = null
    let reopen = false
    const refresh = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        const s = useApp.getState()
        if (reopen) s.reloadOpen()
        reopen = false
        s.loadList(true)
        s.refreshMeta()
      }, 400)
    }
    const sameStatus = (a: Status | undefined, b: Status) =>
      !!a && a.state === b.state && a.error === b.error && a.progressDone === b.progressDone && a.progressTotal === b.progressTotal && a.fails === b.fails && a.log.length === b.log.length && a.log[a.log.length - 1] === b.log[b.log.length - 1]
    const subs = [
      on('mail-changed', refresh),
      // 同步状态：没变化就不更新，免得整棵界面跟着重绘
      on<Status>('account-status', (st) => {
        const cur = useApp.getState().status
        if (sameStatus(cur[st.accountId], st)) return
        useApp.setState({ status: { ...cur, [st.accountId]: st } })
      }),
      on<{ msgId: number; state: string; error?: string }>('ai-state', (p) => {
        if (p.state === 'running') return
        // 正在看的这封重新分析失败（原批注保留着）：提示一下
        if (p.state === 'failed' && useApp.getState().selected === p.msgId && useApp.getState().open?.ai?.state !== 2) useApp.getState().toast(L(`AI 分析没成功：${(p.error || '').slice(0, 80)}`, `AI analysis failed: ${(p.error || '').slice(0, 80)}`), { kind: 'err' })
        if (useApp.getState().selected === p.msgId) reopen = true
        refresh()
      }),
      on<{ version: string; notes: string }>('update-available', (u) => {
        const s = useApp.getState()
        s.toast(L(`有新版本 ${u.version}${u.notes ? `：${u.notes.slice(0, 60)}` : ''}`, `Version ${u.version} is available${u.notes ? `: ${u.notes.slice(0, 60)}` : ''}`), { action: { label: L('更新', 'Update'), run: () => useApp.getState().installUpdate(u.version) }, ttl: 30000 })
      }),
      on('tray-compose', () => { const s = useApp.getState(); if (s.accounts.length) s.openCompose('new') }),
    ]
    return () => { subs.forEach((p) => p.then((f) => f())) }
  }, [])
}

function useShortcuts(searchRef: React.RefObject<HTMLInputElement>) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const s = useApp.getState()
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus(); return }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); s.set({ page: 'settings' }); return }
      // Ctrl+A：选中列表里已加载的全部邮件（输入框里照常全选文字）
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !isTyping(e) && s.page === 'mail' && !s.compose && !s.addAccount && !s.repairAccount && !s.movePick && s.items.length) {
        e.preventDefault(); s.set({ checked: new Set(s.items.map((m) => m.id)) }); return
      }
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || s.compose || s.addAccount || s.repairAccount || s.movePick || s.guide || document.querySelector('.menu')) return
      if (!s.accounts.length) return
      const idx = curRow(s)
      const cur = s.open
      const targets = s.checked.size ? [...s.checked] : s.selected ? [s.selected] : []
      switch (e.key) {
        case 'c': e.preventDefault(); s.openCompose('new'); break
        case '/': e.preventDefault(); searchRef.current?.focus(); break
        case 'j': case 'ArrowDown': if (s.page === 'mail' && s.items.length) { e.preventDefault(); s.select(s.items[Math.min(s.items.length - 1, idx + 1)]?.id ?? s.items[0].id) } break
        case 'k': case 'ArrowUp': if (s.page === 'mail' && idx > 0) { e.preventDefault(); s.select(s.items[idx - 1].id) } break
        case 'e': if (targets.length && s.page === 'mail') s.move(targets, 'archive', L('归档', 'archived')); break
        // Mac 键盘上的 delete 键发的是 Backspace
        case 'Backspace': if (!IS_MAC) break
        // falls through
        case 'Delete': case '#': if (targets.length && s.page === 'mail') s.move(targets, 'trash', L('删除', 'deleted')); break
        case 's': if (targets.length) { const m = s.items.find((x) => x.id === targets[0]); s.mark(targets, { flagged: !m?.flagged }) } break
        case 'u': if (targets.length) { const m = s.items.find((x) => x.id === targets[0]); s.mark(targets, { seen: !m?.seen }) } break
        case 'r': if (cur) { e.preventDefault(); s.openCompose('reply', cur) } break
        case 'a': if (cur) { e.preventDefault(); s.openCompose('replyAll', cur) } break
        case 'f': if (cur) { e.preventDefault(); s.openCompose('forward', cur) } break
        case 'Escape': if (s.checked.size) s.set({ checked: new Set() }); else if (s.page !== 'mail') s.set({ page: 'mail' }); else if (s.selected) s.select(null); break
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
}

function App() {
  const s = useApp()
  const searchRef = useRef<HTMLInputElement>(null)
  useTheme()
  useBackendEvents()
  useShortcuts(searchRef)

  useEffect(() => {
    s.boot().catch(() => {}).finally(() => {
      // 页面准备好再显示窗口，避免启动时白屏闪一下；开机静默启动时后端忽略这次请求
      api.showMain(true).catch(() => {})
    })
    // 右键菜单只在邮件列表等处自定义，别的地方屏蔽浏览器默认菜单
    const ctx = (e: MouseEvent) => { if (!isEditable(e.target)) e.preventDefault() }
    window.addEventListener('contextmenu', ctx)
    return () => window.removeEventListener('contextmenu', ctx)
  }, [])

  if (!s.ready) return <div className="app"><TitleBar /><div className="body"><Loader text="" width={180} /></div></div>

  return (
    <div className="app">
      <TitleBar searchRef={searchRef} />
      <div className="body">
        {s.accounts.length === 0 ? <Welcome /> : (
          <>
            {s.page !== 'settings' && <Sidebar />}
            {s.page === 'mail' && <div className="panel"><MailList /><Reader /></div>}
            {s.page === 'todo' && <div className="panel"><TodoPage /></div>}
            {s.page === 'digest' && <div className="panel"><DigestPage /></div>}
            {s.page === 'settings' && <SettingsPage />}
          </>
        )}
      </div>
      {s.compose && <Compose key={s.compose.key} />}
      {s.movePick && <MovePicker />}
      {s.addAccount && <AddAccount />}
      {s.repairAccount && <RepairAccount />}
      <GuideSheet />
      <Toasts />
    </div>
  )
}

const isEditable = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)

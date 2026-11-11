import { create } from 'zustand'
import { ask } from './lib/ask'
import { api, errText, type Account, type AskOut, type CatCount, type Counts, type Folder, type MsgFull, type MsgLite, type Settings, type Status, type DraftIn } from './lib/api'
import { L, syncLang } from './lib/i18n'

/** 点了发送、还在可撤销倒计时里的邮件数：这时不能重新加载界面（换语言） */
export const pendingSends = { n: 0 }

export type View =
  | { kind: 'all'; accountId?: number }
  | { kind: 'important' }
  | { kind: 'later' }
  | { kind: 'bills' }
  | { kind: 'followup' }
  | { kind: 'sent' }
  | { kind: 'drafts' }
  | { kind: 'folder'; folderId: number; accountId: number }

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward' | 'draft'
export type Compose = {
  key: number; mode: ComposeMode; base?: MsgFull | null; draftId?: number | null
  prefill?: { to?: string; subject?: string; body?: string; accountId?: number }
  /** 重新打开草稿 / 撤销发送：整封恢复（抄送、密送、附件、回复关系） */
  draft?: DraftIn
}
export type Toast = { id: number; text: string; kind?: 'err'; action?: { label: string; run: () => void }; ttl?: number }
export type Page = 'mail' | 'todo' | 'digest' | 'settings'

const PAGE = 80
let seq = 0
let listRequestSeq = 0

type S = {
  ready: boolean
  accounts: Account[]
  folders: Folder[]
  settings: Settings | null
  status: Record<number, Status>
  counts: Counts
  aiConfigured: boolean
  aiUsedToday: number
  version: string
  /** 这个版本能用的一键登录 */
  oauth: string[]
  page: Page
  settingsTab: string
  view: View
  filter: string
  /** 当前视图里各 AI 分类的封数（分类页签、整理用） */
  cats: CatCount[]
  search: string
  /** 问邮箱：搜索框里的问题交给 AI 回答 */
  ask: { q: string; busy: boolean; out?: AskOut; err?: string } | null
  /** 从简报、问邮箱出处打开的、不在当前列表里的那封：列表刷新时别把它关掉 */
  pinned: number | null
  items: MsgLite[]
  total: number
  loading: boolean
  loadingMore: boolean
  selected: number | null
  checked: Set<number>
  /** 「移动到…」选择框：要移动的邮件（同一个账号） */
  movePick: { ids: number[]; accountId: number } | null
  open: MsgFull | null
  openLoading: boolean
  openError: string
  compose: Compose | null
  addAccount: false | string
  repairAccount: number | null
  /** 教程弹窗（欢迎页用；有账号后在设置里看） */
  guide: boolean
  toasts: Toast[]

  set: (p: Partial<S>) => void
  boot: () => Promise<void>
  refreshMeta: () => Promise<void>
  go: (v: View) => void
  setFilter: (f: string) => void
  doSearch: (q: string) => void
  loadList: (silent?: boolean) => Promise<void>
  loadMore: () => Promise<void>
  select: (id: number | null) => Promise<void>
  reloadOpen: () => Promise<void>
  toggleCheck: (id: number) => void
  mark: (ids: number[], p: { seen?: boolean; flagged?: boolean }) => Promise<void>
  /** 一键已读：当前列表（视图、账号、页签、搜索）里的未读全部标为已读，可撤销 */
  markAllRead: () => Promise<void>
  /** 整理：当前视图里的通知、订阅全部标为已读，可撤销 */
  tidy: () => Promise<void>
  loadCats: () => Promise<void>
  askAi: (q: string) => Promise<void>
  /** 打开某封邮件（从简报、问邮箱的出处跳过来）：不在当前列表里就先回到全部收件箱 */
  openMsg: (id: number, view?: View) => Promise<void>
  /** 整理：把当前视图里符合条件的邮件全部归档（先确认，可撤销） */
  bulkArchive: (over: { filter: string; view?: 'all'; accountId?: null }, what: string) => Promise<void>
  move: (ids: number[], target: string, label: string) => Promise<void>
  removeForever: (ids: number[]) => Promise<void>
  later: (ids: number[], until: number | null) => Promise<void>
  openCompose: (mode: ComposeMode, base?: MsgFull | null, extra?: Partial<Compose>) => void
  /** 去「设置 → AI 与模型」 */
  openAiSettings: () => void
  /** 下载并安装新版本（装完自动重启） */
  installUpdate: (version: string) => Promise<void>
  toast: (text: string, opt?: Partial<Toast>) => number
  drop: (id: number) => void
  saveSettings: (p: Partial<Settings>) => Promise<void>
}

const queryFor = (s: Pick<S, 'view' | 'filter' | 'search'>, offset: number, limit: number) => {
  const v = s.view
  return {
    view: (v.kind === 'drafts' ? 'all' : v.kind === 'folder' ? 'folder' : v.kind) as 'all' | 'important' | 'later' | 'bills' | 'followup' | 'sent' | 'folder',
    accountId: v.kind === 'all' ? v.accountId ?? null : v.kind === 'folder' ? v.accountId : null,
    folderId: v.kind === 'folder' ? v.folderId : null,
    filter: s.filter,
    search: s.search,
    offset,
    limit,
  }
}

let markingAll = false
// 问号、「吗/呢」结尾才算提问；疑问词开头的还要够长，免得「哪吒汽车」「几何」这种搜索也去调模型
const isQuestion = (t: string) => /[?？]\s*$|[吗呢]\s*$/.test(t) || (t.length >= 8 && /^(多少|哪|什么|谁|是否|有没有|几|怎么|为什么|何时|上次|最近一次)/.test(t))
  // 英文：what/when/how 这类疑问词开头且至少 4 个词才算提问；「do not reply」「can opener」这种搜索不算
  || (/^(what|when|where|who|which|how|why)\b/i.test(t) && t.trim().split(/\s+/).length >= 4)
/** 一键已读之后又点开看过的邮件：撤销时不要把它们改回未读 */
const openedSince = new Set<number>()
const BULK_CONFIRM = 50

/** 一键已读 / 整理：按当前列表（可覆盖筛选）把未读标为已读，可撤销 */
async function bulkRead(over: Partial<ReturnType<typeof queryFor>>, emptyText: string, doneText: (n: number) => string, confirmText: (n: number) => string) {
  if (markingAll) return // 连点两下只标一次
  markingAll = true
  const s = useApp.getState()
  try {
    // 只标列表画出来时已有的邮件，刚到、还没显示的新信不动
    const maxId = s.items.reduce((m, x) => Math.max(m, x.id), 0)
    const q = { ...queryFor(s, 0, 1), ...over, maxId: maxId || null }
    // 封数多（多半包括没加载出来的）先确认，免得误点一下把几千封都标了
    const pre = await api.markViewRead(q, true)
    if (!pre.length) { s.toast(emptyText); return }
    if (pre.length > BULK_CONFIRM && !await ask(confirmText(pre.length))) return
    const ids = await api.markViewRead(q)
    if (!ids.length) { s.toast(emptyText); return }
    openedSince.clear()
    const hit = new Set(ids)
    useApp.setState({ items: useApp.getState().items.map((m) => (hit.has(m.id) ? { ...m, seen: true } : m)) })
    s.toast(doneText(ids.length), { action: { label: L('撤销', 'Undo'), run: () => s.mark(ids.filter((id) => !openedSince.has(id)), { seen: false }) }, ttl: 6000 })
  } catch (e) { s.toast(errText(e), { kind: 'err' }) } finally { markingAll = false }
}

export const useApp = create<S>((set, get) => ({
  ready: false,
  accounts: [],
  folders: [],
  settings: null,
  status: {},
  counts: { inboxUnread: 0, important: 0, todos: 0, later: 0, drafts: 0, bills: 0, followups: 0 },
  aiConfigured: false,
  aiUsedToday: 0,
  version: '',
  oauth: [],
  page: 'mail',
  settingsTab: 'general',
  view: { kind: 'all' },
  filter: 'all',
  cats: [],
  search: '',
  ask: null,
  pinned: null,
  items: [],
  total: 0,
  loading: true,
  loadingMore: false,
  selected: null,
  checked: new Set(),
  movePick: null,
  open: null,
  openLoading: false,
  openError: '',
  compose: null,
  addAccount: false,
  repairAccount: null,
  guide: false,
  toasts: [],

  set: (p) => set(p),

  boot: async () => {
    const b = await api.bootstrap()
    // 设置里的语言和当前显示的不一样（换了系统语言、或在别处改过）：重新加载成对的语言
    if (syncLang(b.lang)) return
    const status: Record<number, Status> = {}
    for (const s of b.status) status[s.accountId] = s
    set({ accounts: b.accounts, folders: b.folders, settings: b.settings, status, counts: b.counts, aiConfigured: b.aiConfigured, aiUsedToday: b.aiUsedToday, version: b.version, oauth: b.oauth, ready: true })
    if (b.accounts.length) await get().loadList()
  },

  refreshMeta: async () => {
    try {
      const b = await api.bootstrap()
      set({ accounts: b.accounts, folders: b.folders, counts: b.counts, aiConfigured: b.aiConfigured, aiUsedToday: b.aiUsedToday })
    } catch { /* 后台刷新失败不打扰 */ }
  },

  go: (v) => {
    set({ pinned: null, page: 'mail', view: v, filter: 'all', cats: [], search: '', selected: null, open: null, checked: new Set(), items: [], loading: true })
    if (v.kind === 'folder') api.openFolder(v.folderId).catch(() => {})
    if (v.kind !== 'drafts') get().loadList()
    else set({ loading: false })
  },

  setFilter: (f) => {
    set({ pinned: null, filter: f, selected: null, open: null, checked: new Set(), items: [], loading: true })
    get().loadList()
  },

  doSearch: (q) => {
    const t = q.trim()
    set({ pinned: null, page: 'mail', search: t, ask: null, selected: null, open: null, checked: new Set(), items: [], loading: true })
    get().loadList()
    // 像是在提问（问号结尾、疑问词开头）就直接问 AI，结果显示在搜索结果上方
    if (t && get().aiConfigured && isQuestion(t)) get().askAi(t)
  },

  askAi: async (q) => {
    set({ ask: { q, busy: true } })
    try {
      const out = await api.aiAsk(q)
      if (get().ask?.q === q) set({ ask: { q, busy: false, out } })
    } catch (e) {
      if (get().ask?.q === q) set({ ask: { q, busy: false, err: errText(e) } })
    }
  },

  openMsg: async (id, view) => {
    // 指定了视图（待跟进、账单发票）就切过去；否则留在原地（问邮箱的答案、搜索结果都还在），信不在列表里也照样打开
    if (view) {
      set({ page: 'mail', view, filter: 'all', cats: [], search: '', ask: null, checked: new Set() })
      await get().loadList()
    } else if (get().page !== 'mail') {
      set({ page: 'mail' })
      if (!get().items.length) await get().loadList()
    }
    set({ pinned: get().items.some((m) => m.id === id) ? null : id })
    await get().select(id)
  },

  bulkArchive: async (over, what) => {
    const s = get()
    try {
      // 封数是确认框里给用户看过的；这里不用当前列表的 maxId（换了筛选、视图时它对不上）
      const ids = await api.viewIds({ ...queryFor(s, 0, 1), search: '', ...over, maxId: null })
      if (!ids.length) { s.toast(L(`没有要归档的${what}`, `No ${what} to archive`)); return }
      if (!await ask(L(`把 ${ids.length} 封${what}都归档？归档后可以在「归档」文件夹里找到，弹出的提示里也能撤销。`, `Archive ${ids.length} ${what}? You'll find them in the Archive folder, and you can undo from the notice that appears.`))) return
      await get().move(ids, 'archive', L('归档', 'archived'))
    } catch (e) { s.toast(errText(e), { kind: 'err' }) }
  },

  loadList: async (silent = false) => {
    const s = get()
    if (s.view.kind === 'drafts') return
    const request = ++listRequestSeq
    if (!silent) set({ loading: true })
    const key = JSON.stringify(queryFor(s, 0, 0))
    try {
      const r = await api.list(queryFor(s, 0, Math.max(PAGE, silent ? s.items.length : 0)))
      if (request !== listRequestSeq || JSON.stringify(queryFor(get(), 0, 0)) !== key) return // 期间又发起了更新的列表请求，或切换了视图
      set({ items: r.items, total: r.total })
      get().loadCats()
      // 选中的邮件被移走了：自动选下一封
      const sel = get().selected
      if (sel && sel !== get().pinned && !r.items.some((m) => m.id === sel)) set({ selected: null, open: null })
    } catch (e) {
      if (request === listRequestSeq) get().toast(errText(e), { kind: 'err' })
    } finally {
      if (request === listRequestSeq && JSON.stringify(queryFor(get(), 0, 0)) === key) set({ loading: false })
    }
  },

  loadMore: async () => {
    const s = get()
    if (s.loadingMore || s.items.length >= s.total) return
    set({ loadingMore: true })
    const key = JSON.stringify(queryFor(s, 0, 0))
    const request = listRequestSeq
    try {
      const r = await api.list(queryFor(s, s.items.length, PAGE))
      if (request !== listRequestSeq || JSON.stringify(queryFor(get(), 0, 0)) !== key) return
      const have = new Set(get().items.map((m) => m.id))
      set({ items: [...get().items, ...r.items.filter((m) => !have.has(m.id))], total: r.total })
    } finally {
      set({ loadingMore: false })
    }
  },

  select: async (id) => {
    set({ selected: id, openError: '', ...(id !== get().pinned ? { pinned: null } : {}) })
    if (id == null) { set({ open: null }); return }
    openedSince.add(id)
    const lite = get().items.find((m) => m.id === id)
    set({ openLoading: true, open: get().open?.id === id ? get().open : null })
    try {
      const full = await api.get(id)
      if (get().selected !== id) return
      set({ open: full })
      // 不在列表里的（从简报、问邮箱打开）按完整邮件判断
      const st = lite ?? full
      if (!st.seen && st.role !== 'drafts') get().mark([id], { seen: true })
    } catch (e) {
      if (get().selected === id) set({ openError: errText(e) })
    } finally {
      if (get().selected === id) set({ openLoading: false })
    }
  },

  reloadOpen: async () => {
    const id = get().selected
    if (!id) return
    try {
      const full = await api.get(id)
      if (get().selected === id) set({ open: full })
    } catch { /* ignore */ }
  },

  toggleCheck: (id) => {
    const c = new Set(get().checked)
    if (c.has(id)) c.delete(id)
    else c.add(id)
    set({ checked: c })
  },

  markAllRead: () => bulkRead({}, L('这里没有未读邮件', 'No unread emails here'), (n) => L(`已把 ${n} 封标为已读`, `Marked ${n} as read`), (n) => L(`把这里的 ${n} 封未读邮件都标为已读？`, `Mark all ${n} unread emails here as read?`)),
  tidy: () => bulkRead({ filter: 'bulk', search: '' }, L('通知和订阅都已经读过了', 'All notifications and newsletters are already read'), (n) => L(`已把 ${n} 封通知和订阅标为已读`, `Marked ${n} notifications and newsletters as read`), (n) => L(`把 ${n} 封没读的通知和订阅都标为已读？`, `Mark ${n} unread notifications and newsletters as read?`)),
  loadCats: async () => {
    const s = get()
    const k = s.view.kind
    if (k !== 'all' && k !== 'folder') { if (s.cats.length) set({ cats: [] }); return }
    const key = JSON.stringify(queryFor(s, 0, 0))
    try {
      const cats = await api.categoryCounts({ ...queryFor(s, 0, 0), filter: '', search: '' })
      if (JSON.stringify(queryFor(get(), 0, 0)) === key) set({ cats })
    } catch { /* 页签数字拿不到就不显示 */ }
  },
  mark: async (ids, p) => {
    if (!ids.length) return
    const hit = new Set(ids)
    // 先改界面
    set({
      items: get().items.map((m) => (hit.has(m.id) ? { ...m, ...(p.seen != null ? { seen: p.seen } : {}), ...(p.flagged != null ? { flagged: p.flagged } : {}) } : m)),
      open: get().open && hit.has(get().open!.id) ? { ...get().open!, ...(p.seen != null ? { seen: p.seen } : {}), ...(p.flagged != null ? { flagged: p.flagged } : {}) } : get().open,
    })
    try {
      await api.mark(ids, p) // 后端会发 mail-changed，计数随之刷新
    } catch (e) {
      get().toast(errText(e), { kind: 'err' })
      get().loadList(true)
    }
  },

  move: async (ids, target, label) => {
    const s = get()
    const picked = s.items.filter((m) => ids.includes(m.id))
    if (target === 'trash' && picked.length && picked.every((m) => m.role === 'trash')) {
      if (await ask(L(`彻底删除这 ${picked.length} 封邮件？删除后不能恢复。`, `Permanently delete ${picked.length === 1 ? 'this email' : `these ${picked.length} emails`}? This can't be undone.`))) await get().removeForever(ids)
      return
    }
    const idx = s.selected ? s.items.findIndex((m) => m.id === s.selected) : -1
    const rest = s.items.filter((m) => !ids.includes(m.id))
    let next: number | null = s.selected
    if (s.selected && ids.includes(s.selected)) next = rest[Math.min(idx, rest.length - 1)]?.id ?? null
    set({ items: rest, total: Math.max(0, s.total - picked.length), checked: new Set() })
    if (next !== s.selected) get().select(next)
    try {
      const token = await api.move(ids, target)
      // 后端已经把邮件标成 moving；用一次更新后的列表压过可能仍在途中的旧刷新，避免右键删除后邮件重新出现
      await get().loadList(true)
      // label 中文是动作（归档），英文是过去分词（archived）
      get().toast(L(`${ids.length > 1 ? ids.length + ' 封邮件' : '邮件'}已${label}`, `${ids.length > 1 ? ids.length + ' emails' : 'Email'} ${label}`), {
        action: { label: L('撤销', 'Undo'), run: async () => { await api.undoMove(token); get().loadList(true); get().refreshMeta() } },
        ttl: (get().settings?.undoSendSecs || 5) * 1000,
      })
      get().refreshMeta()
    } catch (e) {
      get().toast(errText(e), { kind: 'err' })
      get().loadList(true)
    }
  },

  removeForever: async (ids) => {
    set({ items: get().items.filter((m) => !ids.includes(m.id)), checked: new Set() })
    if (get().selected && ids.includes(get().selected!)) set({ selected: null, open: null })
    try {
      await api.deleteForever(ids)
      await get().loadList(true)
      get().toast(L(`已彻底删除 ${ids.length} 封邮件`, ids.length === 1 ? 'Email permanently deleted' : `${ids.length} emails permanently deleted`))
      get().refreshMeta()
    } catch (e) {
      get().toast(errText(e), { kind: 'err' })
      get().loadList(true)
    }
  },

  later: async (ids, until) => {
    await api.snooze(ids, until)
    if (until) {
      set({ items: get().items.filter((m) => !ids.includes(m.id) || get().view.kind === 'later') })
      if (get().selected && ids.includes(get().selected!) && get().view.kind !== 'later') set({ selected: null, open: null })
      get().toast(L('已放到「稍后处理」', 'Snoozed'))
    }
    get().refreshMeta()
  },

  openCompose: (mode, base = null, extra = {}) => set({ compose: { key: ++seq, mode, base, ...extra } }),
  openAiSettings: () => set({ page: 'settings', settingsTab: 'ai' }),
  installUpdate: async (version) => {
    if (get().compose && !await ask(L('写信窗口还开着，更新会关闭程序（草稿会自动保存）。继续吗？', "You're still writing an email. Updating will close the app (your draft is saved automatically). Continue?"))) return
    const t = get().toast(L(`正在下载 ${version}…装好后会自动重启`, `Downloading ${version}… The app will restart when it's installed`), { ttl: 600000 })
    try { await api.installUpdate() } catch (e) { get().drop(t); get().toast(errText(e), { kind: 'err', ttl: 8000 }) }
  },

  toast: (text, opt = {}) => {
    const id = ++seq
    set({ toasts: [...get().toasts.slice(-2), { id, text, ...opt }] })
    setTimeout(() => get().drop(id), opt.ttl ?? (opt.kind === 'err' ? 5000 : 3200))
    return id
  },
  drop: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  saveSettings: async (p) => {
    const cur = get().settings
    if (!cur) return
    // 换语言要重新加载界面：写信窗口开着、或刚点了发送还在可撤销的那几秒里，会丢内容或发不出去
    if (p.language !== undefined && p.language !== cur.language && (get().compose || pendingSends.n > 0)) {
      get().toast(L('先关闭写信窗口、等发送完成，再切换语言', 'Close the compose window and wait for sending to finish before switching language'), { kind: 'err' })
      return
    }
    const next = { ...cur, ...p }
    set({ settings: next })
    try {
      const saved = await api.saveSettings(next)
      set({ settings: saved })
      // 保存期间可能打开了写信窗口或点了发送：那就先不重新加载，下次启动生效
      if (p.language !== undefined) {
        const lang = await api.uiLang()
        if (get().compose || pendingSends.n > 0) get().toast(L('语言已保存，下次启动时生效', 'Language saved. It takes effect the next time Kojoo Mail starts'))
        else syncLang(lang)
      }
    } catch (e) {
      set({ settings: cur })
      get().toast(errText(e), { kind: 'err' })
    }
  },
}))

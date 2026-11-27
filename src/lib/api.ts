// 和 Rust 后端通信：invoke 调命令，listen 收事件
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { L } from './i18n'

export type Addr = { name: string; email: string }
export type Account = {
  id: number; email: string; displayName: string; label: string; color: string; provider: string
  imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; smtpTls: boolean; saveSent: boolean; aiAllowed: boolean; signature: string
  /** password：密码/授权码；oauth：一键登录 */
  auth: 'password' | 'oauth'
  /** 常用分类：列表上方的筛选页签 */
  focus: string[]
  /** full：完整批注；classify：只分类 */
  aiLevel: 'full' | 'classify'
}

/** 可以选作常用分类的 AI 类别（「其他」不当页签） */
export const FOCUS_CATS = ['询盘', '待办', '账单', '通知', '订阅', '个人'] as const
export type Folder = { id: number; accountId: number; path: string; name: string; role: string; unread: number; total: number; delim: string }
export type Status = {
  accountId: number; state: 'connecting' | 'syncing' | 'idle' | 'error' | 'offline' | ''; error: string; errorKind: '' | 'auth' | 'network' | 'store'
  lastOk: number; fails: number; progressDone: number; progressTotal: number; log: string[]
}
export type Settings = {
  theme: 'system' | 'light' | 'dark'; fontSize: number; density: 'compact' | 'standard' | 'cozy'; serifTitles: boolean
  autostart: boolean; closeToTray: boolean; defaultAccount: number | null; notify: 'important' | 'all' | 'none'
  remoteImages: 'ask' | 'always'; undoSendSecs: number
  notifyPreview: boolean; aiProvider: string; aiBase: string; aiModel: string; aiModelFine: string; aiModelBackup: string; aiAuto: boolean; aiTodos: boolean; aiScope: 'skip_bulk' | 'all' | 'important'; aiDailyLimit: number
  /** 自定义要求：追加到批注、起草回复、跟进邮件的提示词末尾 */
  aiCustom: string
  language: 'auto' | 'zh' | 'en'
  /** 按会话显示：同一来回的邮件在列表里合成一行 */
  conversationView: boolean
  /** 代理：跟随系统 / 不用 / 自定义地址（HTTP 代理，主机:端口） */
  proxyMode: 'system' | 'off' | 'custom'; proxyAddr: string
  /** 允许外部 AI Agent 通过 MCP 只读本机邮件（默认关） */
  mcpRead: boolean
}
/** 发票台账的筛选：购买方 / 销售方传空字符串 = 没读出来的那些；日期是开票日期 YYYY-MM-DD */
export type InvoiceFilter = { buyer?: string; seller?: string; accountId?: number; from?: string; to?: string; q?: string; onlyCheck?: boolean; hidden?: boolean; project?: number }
/** 发票项目：存下来的一组条件（buyer / seller 不填 = 不限，空字符串 = 没读出来的；accounts 空 = 全部邮箱；from / to 是开票日期），符合的发票自动归进来。count / total 是现在项目里的张数和合计（分） */
export type InvoiceProject = { id: number; name: string; buyer?: string | null; seller?: string | null; accounts: number[]; from: string; to: string; count: number; total: number }
/** 一张发票。金额单位是分；mails > 1 = 重复收到过（只算一张）；source 是信息读自哪种文件 */
export type InvoiceRow = { id: number; number: string; date: string; amount: number | null; tax: number | null; seller: string; buyer: string; kind: string; source: 'xml' | 'ofd' | 'pdf' | string; needsCheck: boolean; edited: boolean; hidden: boolean; mails: number; accounts: number[]; hasPdf: boolean }
export type InvoiceListing = { items: InvoiceRow[]; count: number; total: number; noAmount: number; buyers: [string, number][]; sellers: [string, number][]; accounts: [number, number][]; months: [string, number][]; all: number; check: number; hidden: number; projects: InvoiceProject[] }
export type InvoiceFile = { id: number; name: string; ext: string; size: number; msgId: number; role: 'invoice' | 'extra' }
export type InvoiceDetail = { sellerTax: string; buyerTax: string; files: InvoiceFile[]; extras: InvoiceFile[]; mails: { msgId: number; accountId: number; subject: string; from: string; date: number }[] }
export type Counts = { inboxUnread: number; important: number; todos: number; later: number; drafts: number; bills: number; followups: number }
export type CatCount = { cat: string; total: number; unread: number }
export type Boot = { accounts: Account[]; folders: Folder[]; settings: Settings; status: Status[]; aiConfigured: boolean; aiUsedToday: number; counts: Counts; version: string; oauth: string[]; lang: 'zh' | 'en'; exePath?: string }
export type MsgLite = {
  id: number; accountId: number; folderId: number; role: string; fromName: string; fromAddr: string; to: Addr[]; subject: string; snippet: string
  date: number; seen: boolean; flagged: boolean; answered: boolean; hasAtt: boolean; bulk: boolean
  aiCategory: string; aiPriority: string; aiSummary: string; openTodos: number; later: number | null
  /** 按会话显示时：这一行代表的整串会话（count 是封数，who 是参与的人） */
  thread?: { id: number; count: number; unread: number; who: string[]; hasAtt: boolean; flagged: boolean }
}
export type Fact = { k: string; v: string }
export type AiResult = { state: number; summary: string; category: string; priority: string; reason: string; facts: Fact[]; reply: string; replyLang: string; model: string; error: string }
export type Todo = {
  id: number; msgId: number | null; accountId: number | null; text: string; due: number | null; priority: string; done: boolean; doneAt: number | null
  source: string; srcSubject: string; srcFrom: string; created: number
}
export type Att = { idx: number; name: string; size: number; mime: string; inline: boolean }
export type MsgFull = MsgLite & { cc: Addr[]; replyTo: string; msgid: string; refs: string; inReplyTo: string; text: string; html: string; atts: Att[]; ai: AiResult | null; aiPending: boolean; todos: Todo[]; code: string }
export type Draft = { id: number; accountId: number | null; to: Addr[]; cc: Addr[]; bcc: Addr[]; subject: string; body: string; replyMsg: number | null; mode: string; updated: number; attachments: string[]; quote: string; sig: number }
export type ListQuery = { view: 'all' | 'important' | 'later' | 'bills' | 'followup' | 'sent' | 'folder'; accountId?: number | null; folderId?: number | null; filter?: string; search?: string; maxId?: number | null; threads?: boolean; offset: number; limit: number }
export type DigestItem = { id: number; accountId: number; who: string; subject: string; summary: string; date: number; seen: boolean; high: boolean }
export type DigestTodo = { id: number; msgId: number | null; text: string; due: number | null }
export type Digest = { reply: DigestItem[]; bills: DigestItem[]; todos: DigestTodo[]; followups: DigestItem[]; followupTotal: number; bulkUnread: number; newCount: number }
export type Overview = { text: string; at: number }
export type AskSource = { n: number; id: number; accountId: number; who: string; subject: string; date: number }
export type AskOut = { answer: string; sources: AskSource[]; keywords: string[] }
export type AccountIn = {
  email: string; password: string; provider: string; displayName: string; label: string; color: string; username?: string
  imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; smtpTls: boolean; saveSent: boolean
  oauthTicket?: string
}
export type DraftIn = { id?: number | null; accountId: number; to: Addr[]; cc: Addr[]; bcc: Addr[]; subject: string; body: string; html: string; replyMsg?: number | null; mode: string; attachments: string[]; /** 引用 / 转发的原邮件，草稿里和正文分开存 */ quote?: string; /** 1 带签名 / 2 这封不带 / 0 老草稿（签名还在正文里） */ sig?: number }
export type RuleCond = { field: 'from' | 'to' | 'subject' | 'attachment'; op: 'contains' | 'not_contains' | 'equals' | 'has' | 'none'; value: string }
export type RuleAction = { kind: 'move' | 'archive' | 'junk' | 'read' | 'unread' | 'flag' | 'unflag'; folder: string }
export type Rule = { id: number; name: string; enabled: boolean; accountId: number | null; matchAll: boolean; conds: RuleCond[]; actions: RuleAction[]; stop: boolean }

const call = <T,>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args)

export const api = {
  bootstrap: () => call<Boot>('bootstrap'),
  counts: () => call<Counts>('get_counts'),
  folders: () => call<Folder[]>('get_folders'),
  list: (q: ListQuery) => call<{ items: MsgLite[]; total: number }>('list_messages', { q }),
  /** 把当前列表里的未读全部标为已读，返回标了哪些 */
  markViewRead: (q: ListQuery, dry = false) => call<number[]>('mark_view_read', { q, dry }),
  categoryCounts: (q: ListQuery) => call<CatCount[]>('category_counts', { q }),
  /** 当前列表里的邮件 id（批量归档用） */
  viewIds: (q: ListQuery) => call<number[]>('view_ids', { q }),
  digest: () => call<Digest>('digest'),
  digestOverview: (force = false) => call<Overview>('digest_overview', { force }),
  aiAsk: (question: string) => call<AskOut>('ai_ask', { question }),
  followupSet: (id: number, off: boolean) => call<void>('followup_set', { id, off }),
  aiFollowup: (id: number) => call<string>('ai_followup', { id }),
  get: (id: number) => call<MsgFull>('get_message', { id }),
  /** 这封邮件所在的整串会话（按时间从早到晚） */
  thread: (id: number) => call<{ id: number; accountId: number; items: MsgLite[] }>('thread_messages', { id }),
  mark: (ids: number[], p: { seen?: boolean; flagged?: boolean }) => call<void>('mark', { ids, seen: p.seen ?? null, flagged: p.flagged ?? null }),
  snooze: (ids: number[], until: number | null) => call<void>('snooze', { ids, until }),
  move: (ids: number[], target: string) => call<number>('move_to', { ids, target }),
  undoMove: (token: number) => call<boolean>('undo_move', { token }),
  deleteForever: (ids: number[]) => call<void>('delete_forever', { ids }),
  createFolder: (accountId: number, name: string, parentFolderId: number | null = null) => call<void>('create_folder', { accountId, name, parentFolderId }),
  renameFolder: (folderId: number, name: string) => call<void>('rename_folder', { folderId, name }),
  deleteFolder: (folderId: number) => call<void>('delete_folder', { folderId }),
  openFolder: (folderId: number) => call<void>('open_folder', { folderId }),
  syncNow: () => call<void>('sync_now'),
  rules: () => call<Rule[]>('rule_list'),
  ruleSave: (rule: Rule) => call<number>('rule_save', { rule }),
  ruleDelete: (id: number) => call<void>('rule_delete', { id }),
  ruleOrder: (ids: number[]) => call<void>('rule_order', { ids }),
  testAccount: (input: AccountIn) => call<void>('test_account', { input }),
  addAccount: (input: AccountIn) => call<number>('add_account', { input }),
  updateAccount: (id: number, patch: Partial<{ displayName: string; label: string; color: string; signature: string; aiAllowed: boolean; password: string; oauthTicket: string; focus: string[]; aiLevel: 'full' | 'classify' }>) => call<void>('update_account', { id, patch }),
  /** 打开浏览器一键登录，完成后返回票据和登录的邮箱 */
  oauthLogin: (provider: string, hint?: string) => call<{ ticket: string; email: string }>('oauth_login', { provider, hint: hint ?? null }),
  oauthCancel: () => call<void>('oauth_cancel'),
  removeAccount: (id: number) => call<void>('remove_account', { id }),
  retryAccount: (id: number) => call<void>('retry_account', { id }),
  accountOrder: (ids: number[]) => call<void>('account_order', { ids }),
  send: (d: DraftIn) => call<void>('send_mail', { d }),
  saveDraft: (d: DraftIn) => call<number>('save_draft', { d }),
  drafts: () => call<Draft[]>('list_drafts'),
  deleteDraft: (id: number) => call<void>('delete_draft', { id }),
  contacts: (q: string) => call<Addr[]>('contacts', { q }),
  saveAttachment: (msgId: number, idx: number) => call<string>('save_attachment', { msgId, idx }),
  openUrl: (url: string) => call<void>('open_url', { url }),
  precheckSend: (d: DraftIn) => call<void>('precheck_send', { d }),
  openAttachment: (msgId: number, idx: number) => call<void>('open_attachment', { msgId, idx }),
  printHtml: (html: string) => call<void>('print_html', { html }),
  emptyFolder: (folderId: number) => call<number>('empty_folder', { folderId }),
  todos: (filter: string) => call<Todo[]>('list_todos', { filter }),
  todoSet: (id: number, p: { done?: boolean; text?: string; due?: number | null; priority?: string }) =>
    call<void>('todo_set', { id, done: p.done ?? null, text: p.text ?? null, due: p.due ?? null, clearDue: 'due' in p && p.due === null, priority: p.priority ?? null }),
  todoAdd: (text: string, due: number | null, msgId: number | null) => call<number>('todo_add', { text, due, msgId }),
  todoDelete: (id: number) => call<void>('todo_delete', { id }),
  todoClear: (scope: 'done' | 'ai' | 'all') => call<number>('todo_clear', { scope }),
  // 发票台账
  invoiceList: (filter: InvoiceFilter) => call<InvoiceListing>('invoice_list', { filter }),
  invoiceDetail: (id: number) => call<InvoiceDetail | null>('invoice_detail', { id }),
  invoiceUpdate: (id: number, patch: { number?: string; date?: string; amount?: string; seller?: string; buyer?: string; hidden?: boolean }) => call<void>('invoice_update', { id, patch }),
  /** 把还没看过的邮件在后台扫一遍，返回还要扫几封 */
  invoiceSync: () => call<number>('invoice_sync'),
  invoiceOpen: (fileId: number) => call<void>('invoice_open', { fileId }),
  /** 导出成压缩包，返回 [存到哪了, 没取到的文件数] */
  invoiceExport: (ids: number[], label?: string) => call<[string, number]>('invoice_export', { ids, label: label ?? null }),
  /** 新建（id = 0）或修改一个发票项目，返回它的编号 */
  invoiceProjectSave: (project: Omit<InvoiceProject, 'count' | 'total'>) => call<number>('invoice_project_save', { project }),
  invoiceProjectDelete: (id: number) => call<void>('invoice_project_delete', { id }),
  /** 手动把一张发票加进项目（add）、移出（remove）、撤掉手动调整（reset） */
  invoiceProjectItem: (project: number, invoice: number, action: 'add' | 'remove' | 'reset') => call<void>('invoice_project_item', { project, invoice, action }),
  aiAnalyze: (id: number) => call<void>('ai_analyze', { id }),
  aiDraft: (id: number, tone: string, lang: string, hint: string) => call<string>('ai_draft', { id, tone, lang, hint }),
  aiRewrite: (text: string, op: string, arg: string) => call<string>('ai_rewrite', { text, op, arg }),
  /** 翻译邮件正文：items 是正文里取出的文字段，按原顺序返回译文（后端按邮件+语言缓存） */
  aiTranslate: (id: number, lang: string, items: string[]) => call<string[]>('ai_translate', { id, lang, items }),
  saveSettings: (s: Settings) => call<Settings>('save_settings', { s }),
  /** 当前界面语言（「跟随系统」由后端按系统语言定） */
  uiLang: () => call<'zh' | 'en'>('ui_lang'),
  setAiKey: (key: string) => call<boolean>('set_ai_key', { key }),
  hasAiKey: () => call<boolean>('has_ai_key'),
  aiTest: () => call<{ ms: number; model: string }>('ai_test'),
  aiModels: () => call<string[]>('ai_models'),
  exportDiagnostics: () => call<string>('export_diagnostics'),
  checkUpdate: () => call<{ version: string; notes: string } | null>('check_update'),
  installUpdate: () => call<void>('install_update'),
  statusList: () => call<Status[]>('status_list'),
  showMain: (boot = false) => call<void>('show_main', { boot }),
  quit: () => call<void>('quit'),
}

export function on<T>(event: string, cb: (p: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => cb(e.payload))
}

export const errText = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : L('出错了', 'Something went wrong'))

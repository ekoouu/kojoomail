// 截图用的假后端：在浏览器里冒充 Tauri，给界面喂演示数据（人物、公司、邮箱全是虚构的）
// 由 shoot.cjs 用 addInitScript 注入，不进正式程序
;(() => {
  // 固定在当天中午：什么时候拍截图，时间、问候语都一样
  const now = new Date().setHours(12, 0, 0, 0)
  const H = 3600e3, D = 24 * H
  const t = (ms) => Math.floor((now - ms) / 1000) // 后端时间是秒
  // 英文截图（shoot.cjs 传 __DEMO_LANG__='en'）：同一套故事换成英文版
  const EN = window.__DEMO_LANG__ === 'en'
  const X = (zh, en) => (EN ? en : zh)
  const ME = X('林知夏', 'Lin Xia')

  const accounts = [
    { id: 1, email: 'lin@lumenhome.example', displayName: ME, label: X('外贸 · Gmail', 'Sales · Gmail'), color: '#D4441F', provider: 'gmail' },
    { id: 2, email: 'zhixia@lumen.example', displayName: ME, label: X('公司邮箱', 'Work'), color: '#1B4A80', provider: 'imap' },
    { id: 3, email: X('2873@qq.example', 'linxia@icloud.example'), displayName: ME, label: X('个人 · QQ', 'Personal · iCloud'), color: '#3E7C5A', provider: X('qq', 'icloud') },
    { id: 4, email: 'zx.lin@outlook.example', displayName: ME, label: 'Outlook', color: '#8A5A9E', provider: 'outlook' },
  ].map((a) => ({ imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465, smtpTls: true, saveSent: true, aiAllowed: true, signature: '', auth: a.provider === 'outlook' || a.provider === 'gmail' ? 'oauth' : 'password', focus: ['询盘', '待办', '账单'], aiLevel: 'full', ...a }))

  let fid = 0
  const folders = []
  const unread = { 1: 6, 2: 3, 3: 2, 4: 1 }
  for (const a of accounts) for (const [role, name] of [['inbox', 'INBOX'], ['sent', 'Sent'], ['drafts', 'Drafts'], ['archive', 'Archive'], ['trash', 'Trash']])
    folders.push({ id: ++fid, accountId: a.id, path: name, name, role, unread: role === 'inbox' ? unread[a.id] : 0, total: 100 })
  const inboxOf = (aid) => folders.find((f) => f.accountId === aid && f.role === 'inbox').id

  // [账号, 发件人, 地址, 主题, 摘要, 多久前, 已读, 星标, 附件, 分类, 优先级, AI 一句话, 待办数]
  const rawZh = [
    [1, 'Marco Rossi', 'marco@lumen-srl.example', 'Inquiry: 2,000 sets bamboo cutlery, CIF Genoa', 'Hi Lin, we are interested in your bamboo cutlery set (SKU BC-12) for our autumn line…', 0.4 * H, false, true, true, '询盘', 'high', '意大利客户询价 2000 套竹餐具，CIF 热那亚，要求 11 月 20 日前报价并寄样', 2],
    [2, '财务部 · 周敏', 'zhoumin@lumen.example', '10 月报销单已审核，请补两张发票', '知夏你好，10 月差旅报销已审，缺 10/12 和 10/18 两张住宿发票…', 1.2 * H, false, false, false, '待办', 'high', '财务要你周五前补交 10/12、10/18 两张住宿发票', 1],
    [1, 'Sarah Klein', 'sarah@nordhaus.example', 'Re: Sample feedback & next order', 'Thanks for the samples — the oak trays look great. We would like to move forward with…', 2.5 * H, false, false, false, '询盘', 'high', '德国客户样品反馈满意，准备下单橡木托盘 600 件，问 12 月能否交货', 1],
    [4, '招商银行', 'service@cmb.example', '您的信用卡 11 月账单', '本期应还 ¥8,426.50，最后还款日 11 月 25 日…', 3 * H, true, false, false, '账单', 'normal', '信用卡本期应还 ¥8,426.50，11 月 25 日到期', 0],
    [3, '妈妈', 'mom@qq.example', '周末回来吃饭吗', '你爸说周六炖了排骨，带上小周一起回来吧，几点到提前说一声…', 4 * H, false, false, false, '个人', 'normal', '妈妈问周六回不回家吃饭，记得提前说几点到', 0],
    [2, '陈立 · 产品部', 'chenli@lumen.example', '新品包装打样确认（附设计稿）', '包装打样回来了，附件是三版设计稿，麻烦今天下班前选一版…', 5 * H, true, true, true, '待办', 'high', '产品部请你今天下班前从三版包装设计稿里选定一版', 1],
    [1, 'Alibaba.com', 'noreply@alibaba.example', 'You have 3 new RFQs matching your products', 'Buyers from Spain, Chile and UAE are looking for bamboo kitchenware…', 7 * H, true, false, false, '通知', 'low', '', 0],
    [1, 'DHL Express', 'noreply@dhl.example', '您的样品已签收 · 运单 7745 2210 93', '运单 7745221093 已于 11 月 3 日 14:20 在 Hamburg 签收…', 9 * H, true, false, false, '通知', 'low', '', 0],
    [4, 'GitHub', 'noreply@github.example', '[kojoomail] New issue: support for Yahoo Mail', 'A new issue was opened in your repository…', 20 * H, true, false, false, '通知', 'low', '', 0],
    [2, '人事部', 'hr@lumen.example', '年度体检预约开放', '2026 年度体检已开放预约，请在 11 月 15 日前在系统中选择时段…', 1.1 * D, true, false, false, '待办', 'normal', '年度体检 11 月 15 日前要在系统里约时段', 1],
    [3, '少数派', 'newsletter@sspai.example', '本周精选：把邮箱收拾干净的 7 个习惯', '本周我们聊聊收件箱清零、过滤规则和…', 1.3 * D, true, false, false, '订阅', 'low', '', 0],
    [1, 'Ahmed Al-Sayed', 'ahmed@gulfhome.example', 'Price list request — kitchen storage', 'Dear supplier, please send your latest price list and MOQ for…', 1.6 * D, true, false, false, '询盘', 'normal', '迪拜客户要厨房收纳类最新价目表和起订量', 0],
    [4, '阿里云', 'noreply@aliyun.example', '发票已开具：2026 年 10 月', '您申请的增值税电子普通发票已开具，金额 ¥1,280.00…', 2 * D, true, false, true, '账单', 'normal', '阿里云 10 月发票已开，¥1,280.00', 0],
    [1, 'Canva', 'marketing@canva.example', 'New templates for your brand kit', 'Discover fresh templates…', 2.4 * D, true, false, false, '订阅', 'low', '', 0],
  ]
  const rawEn = [
    [1, 'Marco Rossi', 'marco@lumen-srl.example', 'Inquiry: 2,000 sets bamboo cutlery, CIF Genoa', 'Hi Lin, we are interested in your bamboo cutlery set (SKU BC-12) for our autumn line…', 0.4 * H, false, true, true, '询盘', 'high', 'Italian buyer wants a quote for 2,000 bamboo cutlery sets, CIF Genoa, by Nov 20, plus samples', 2],
    [2, 'Emma Zhou · Finance', 'emma.zhou@lumen.example', 'October expenses approved: 2 receipts missing', 'Hi Lin, your October travel expenses are approved, but we still need the hotel receipts for Oct 12 and Oct 18…', 1.2 * H, false, false, false, '待办', 'high', 'Finance needs your Oct 12 and Oct 18 hotel receipts by Friday', 1],
    [1, 'Sarah Klein', 'sarah@nordhaus.example', 'Re: Sample feedback & next order', 'Thanks for the samples — the oak trays look great. We would like to move forward with…', 2.5 * H, false, false, false, '询盘', 'high', 'German buyer loved the samples and wants 600 oak trays; asks if December delivery works', 1],
    [4, 'Northbank Card Services', 'statements@northbank.example', 'Your November credit card statement', 'Statement balance $1,186.40, payment due November 25…', 3 * H, true, false, false, '账单', 'normal', 'Credit card statement: $1,186.40 due Nov 25', 0],
    [3, 'Mom', 'mom@icloud.example', 'Dinner this Saturday?', 'Dad is making his braised ribs on Saturday. Bring Jamie along and let me know what time you will arrive…', 4 * H, false, false, false, '个人', 'normal', 'Mom asks if you are coming for dinner on Saturday and what time', 0],
    [2, 'Leo Chen · Product', 'leo.chen@lumen.example', 'Packaging samples: please pick a design (3 attached)', 'The packaging samples are back. Three designs attached; please pick one before end of day…', 5 * H, true, true, true, '待办', 'high', 'Product team needs you to pick one of three packaging designs today', 1],
    [1, 'Alibaba.com', 'noreply@alibaba.example', 'You have 3 new RFQs matching your products', 'Buyers from Spain, Chile and UAE are looking for bamboo kitchenware…', 7 * H, true, false, false, '通知', 'low', '', 0],
    [1, 'DHL Express', 'noreply@dhl.example', 'Delivered: shipment 7745 2210 93', 'Your shipment 7745221093 was delivered in Hamburg on Nov 3 at 14:20…', 9 * H, true, false, false, '通知', 'low', '', 0],
    [4, 'GitHub', 'noreply@github.example', '[kojoomail] New issue: support for Yahoo Mail', 'A new issue was opened in your repository…', 20 * H, true, false, false, '通知', 'low', '', 0],
    [2, 'People Team', 'people@lumen.example', 'Annual health check: booking now open', 'Booking for the 2026 health check is open. Please choose a time slot in the portal by Nov 15…', 1.1 * D, true, false, false, '待办', 'normal', 'Book a slot for the annual health check by Nov 15', 1],
    [3, 'The Inbox Weekly', 'hello@inboxweekly.example', '7 habits for a calmer inbox', 'This week: inbox zero, filters that actually help, and…', 1.3 * D, true, false, false, '订阅', 'low', '', 0],
    [1, 'Ahmed Al-Sayed', 'ahmed@gulfhome.example', 'Price list request — kitchen storage', 'Dear supplier, please send your latest price list and MOQ for…', 1.6 * D, true, false, false, '询盘', 'normal', 'Dubai buyer asks for your latest kitchen storage price list and MOQ', 0],
    [4, 'Cloudly', 'billing@cloudly.example', 'Invoice for October 2026', 'Your invoice for October is ready. Amount due: $182.00…', 2 * D, true, false, true, '账单', 'normal', 'Cloudly October invoice: $182.00', 0],
    [1, 'Canva', 'marketing@canva.example', 'New templates for your brand kit', 'Discover fresh templates…', 2.4 * D, true, false, false, '订阅', 'low', '', 0],
  ]
  const raw = EN ? rawEn : rawZh
  const msgs = raw.map((r, i) => ({
    id: 100 + i, accountId: r[0], folderId: inboxOf(r[0]), role: 'inbox', fromName: r[1], fromAddr: r[2],
    to: [{ name: ME, email: accounts[r[0] - 1].email }], subject: r[3], snippet: r[4], date: t(r[5]),
    seen: r[6], flagged: r[7], answered: false, hasAtt: r[8], bulk: r[9] === '通知' || r[9] === '订阅',
    aiCategory: r[9], aiPriority: r[10], aiSummary: r[11], openTodos: r[12], later: null,
  }))

  const todosZh = [
    { id: 1, msgId: 100, accountId: 1, text: '给 Marco 报 2000 套 BC-12 的 CIF 热那亚价格', due: t(-2 * D), priority: 'high', source: 'ai', srcSubject: msgs[0].subject, srcFrom: 'Marco Rossi' },
    { id: 2, msgId: 100, accountId: 1, text: '寄 2 套样品到 Lumen S.r.l.（米兰）', due: t(-5 * D), priority: 'normal', source: 'ai', srcSubject: msgs[0].subject, srcFrom: 'Marco Rossi' },
    { id: 3, msgId: 101, accountId: 2, text: '补交 10/12、10/18 两张住宿发票给财务', due: t(-1 * D), priority: 'high', source: 'ai', srcSubject: msgs[1].subject, srcFrom: '财务部 · 周敏' },
    { id: 4, msgId: 105, accountId: 2, text: '选定新品包装设计稿', due: t(-6 * H), priority: 'high', source: 'ai', srcSubject: msgs[5].subject, srcFrom: '陈立 · 产品部' },
    { id: 5, msgId: 102, accountId: 1, text: '确认橡木托盘 600 件 12 月交期，回复 Sarah', due: t(-3 * D), priority: 'normal', source: 'ai', srcSubject: msgs[2].subject, srcFrom: 'Sarah Klein' },
    { id: 6, msgId: 109, accountId: 2, text: '预约年度体检', due: t(-11 * D), priority: 'normal', source: 'ai', srcSubject: msgs[9].subject, srcFrom: '人事部' },
    { id: 7, msgId: null, accountId: null, text: '整理 Q4 参展样品清单', due: null, priority: 'normal', source: 'manual', srcSubject: '', srcFrom: '' },
  ]
  const todosEn = [
    { id: 1, msgId: 100, accountId: 1, text: 'Quote Marco CIF Genoa pricing for 2,000 sets of BC-12', due: t(-2 * D), priority: 'high', source: 'ai', srcSubject: msgs[0].subject, srcFrom: 'Marco Rossi' },
    { id: 2, msgId: 100, accountId: 1, text: 'Ship 2 sample sets to Lumen S.r.l. (Milan)', due: t(-5 * D), priority: 'normal', source: 'ai', srcSubject: msgs[0].subject, srcFrom: 'Marco Rossi' },
    { id: 3, msgId: 101, accountId: 2, text: 'Send the Oct 12 and Oct 18 hotel receipts to Finance', due: t(-1 * D), priority: 'high', source: 'ai', srcSubject: msgs[1].subject, srcFrom: 'Emma Zhou · Finance' },
    { id: 4, msgId: 105, accountId: 2, text: 'Pick the new packaging design', due: t(-6 * H), priority: 'high', source: 'ai', srcSubject: msgs[5].subject, srcFrom: 'Leo Chen · Product' },
    { id: 5, msgId: 102, accountId: 1, text: 'Confirm December delivery for 600 oak trays and reply to Sarah', due: t(-3 * D), priority: 'normal', source: 'ai', srcSubject: msgs[2].subject, srcFrom: 'Sarah Klein' },
    { id: 6, msgId: 109, accountId: 2, text: 'Book the annual health check', due: t(-11 * D), priority: 'normal', source: 'ai', srcSubject: msgs[9].subject, srcFrom: 'People Team' },
    { id: 7, msgId: null, accountId: null, text: 'Put together the Q4 trade show sample list', due: null, priority: 'normal', source: 'manual', srcSubject: '', srcFrom: '' },
  ]
  const todos = (EN ? todosEn : todosZh).map((x) => ({ done: false, doneAt: null, created: t(1 * D), ...x }))

  const marcoHtml = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#222">
<p>Hi Lin,</p>
<p>Hope you are well. We are Lumen S.r.l., a home-goods distributor based in Milan. We are interested in your <b>bamboo cutlery set (SKU BC-12)</b> for our autumn line and would like a quotation for:</p>
<ul><li>Quantity: <b>2,000 sets</b></li><li>Packaging: kraft box with our logo (artwork attached)</li><li>Incoterms: <b>CIF Genoa</b></li><li>Payment: 30% deposit, 70% against B/L copy</li></ul>
<p>Could you send your best price and lead time <b>by November 20</b>? We would also appreciate 2 sample sets shipped to our Milan office before we confirm.</p>
<p>Best regards,<br>Marco Rossi<br>Purchasing Manager · Lumen S.r.l.</p></div>`
  const sarahHtml = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#222">
<p>Hi Lin,</p>
<p>Thanks for the samples — the oak trays look great and our buyers loved the finish.</p>
<p>We would like to move forward with <b>600 pcs of the large oak tray (OT-40)</b>. Could you confirm whether delivery to Hamburg <b>in December</b> is possible? If so, please send the proforma invoice and we will arrange the deposit right away.</p>
<p>Best,<br>Sarah Klein<br>Nordhaus GmbH</p></div>`
  const full = (m) => ({
    ...m, cc: [], replyTo: '', msgid: `<${m.id}@demo>`, refs: '', inReplyTo: '', text: m.snippet,
    html: m.id === 100 ? marcoHtml : m.id === 102 ? sarahHtml : `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#222"><p>${m.snippet}</p></div>`,
    atts: m.id === 100 ? [{ idx: 0, name: 'Lumen_logo_artwork.pdf', size: 482113, mime: 'application/pdf', inline: false }] : m.hasAtt ? [{ idx: 0, name: X('附件.pdf', 'Attachment.pdf'), size: 210331, mime: 'application/pdf', inline: false }] : [],
    ai: m.aiSummary ? {
      state: 1, summary: m.aiSummary, category: m.aiCategory, priority: m.aiPriority,
      reason: m.id === 100 ? X('新客户询价，有明确数量和截止日期', 'New buyer inquiry with a clear quantity and deadline') : X('需要你处理', 'Needs your action'),
      facts: m.id === 100 ? (EN ? [{ k: 'Product', v: 'Bamboo cutlery set BC-12' }, { k: 'Quantity', v: '2,000 sets' }, { k: 'Incoterms', v: 'CIF Genoa' }, { k: 'Payment', v: '30% deposit, 70% against B/L copy' }, { k: 'Deadline', v: 'Quote by Nov 20' }, { k: 'Samples', v: '2 sets to Milan first' }] : [{ k: '产品', v: '竹餐具套装 BC-12' }, { k: '数量', v: '2,000 套' }, { k: '贸易条款', v: 'CIF 热那亚' }, { k: '付款', v: '30% 定金，70% 见提单副本' }, { k: '截止', v: '11 月 20 日前报价' }, { k: '样品', v: '先寄 2 套到米兰' }]) : [],
      reply: m.id === 100 ? 'Hi Marco,\n\nThank you for your inquiry. We are glad to quote for 2,000 sets of BC-12 with custom kraft boxes, CIF Genoa. Please find our offer attached; lead time is about 35 days after deposit and artwork confirmation.\n\nWe will ship 2 sample sets to your Milan office this week and share the tracking number.\n\nBest regards,\nLin' : '',
      replyLang: m.id === 100 ? 'en' : '', model: 'deepseek-v4-flash', error: '',
    } : null,
    aiPending: false, todos: todos.filter((x) => x.msgId === m.id),
  })

  const settings = { theme: 'light', fontSize: 13, density: 'standard', serifTitles: true, autostart: false, closeToTray: true, defaultAccount: 1, notify: 'important', remoteImages: 'ask', undoSendSecs: 5, notifyPreview: true, aiProvider: 'deepseek', aiBase: 'https://api.deepseek.com/v1', aiModel: 'deepseek-v4-flash', aiModelFine: '', aiModelBackup: '', aiAuto: true, aiTodos: true, aiScope: 'skip_bulk', aiDailyLimit: 200, language: EN ? 'en' : 'zh' }
  if (window.__DEMO_THEME__) settings.theme = window.__DEMO_THEME__
  const counts = { inboxUnread: 12, important: 5, todos: todos.length, later: 2, drafts: 1, bills: 2, followups: 3 }
  const status = accounts.map((a) => ({ accountId: a.id, state: 'idle', error: '', errorKind: '', lastOk: t(60e3), fails: 0, progressDone: 0, progressTotal: 0, log: [] }))
  const item = (m, extra = {}) => ({ id: m.id, accountId: m.accountId, who: m.fromName, subject: m.subject, summary: m.aiSummary, date: m.date, seen: m.seen, high: m.aiPriority === 'high', ...extra })

  const filterList = (q) => {
    let l = msgs
    if (q.accountId) l = l.filter((m) => m.accountId === q.accountId)
    if (q.view === 'important') l = l.filter((m) => m.flagged || m.aiPriority === 'high')
    if (q.view === 'bills') l = l.filter((m) => m.aiCategory === '账单')
    if (q.filter && q.filter !== 'all') l = l.filter((m) => (q.filter === 'unread' ? !m.seen : m.aiCategory === q.filter))
    return l
  }

  const handlers = {
    bootstrap: () => ({ accounts, folders, settings, status, aiConfigured: true, aiUsedToday: 37, counts, version: '0.2.2', oauth: ['gmail', 'outlook'], lang: EN ? 'en' : 'zh' }),
    ui_lang: () => (EN ? 'en' : 'zh'),
    get_counts: () => counts,
    get_folders: () => folders,
    status_list: () => status,
    list_messages: ({ q }) => { const l = filterList(q); return { items: l.slice(q.offset, q.offset + q.limit), total: l.length } },
    category_counts: ({ q }) => {
      const l = filterList({ ...q, filter: 'all' })
      return ['询盘', '待办', '账单', '通知', '订阅', '个人'].map((cat) => ({ cat, total: l.filter((m) => m.aiCategory === cat).length, unread: l.filter((m) => m.aiCategory === cat && !m.seen).length }))
    },
    get_message: ({ id }) => full(msgs.find((m) => m.id === id)),
    list_todos: ({ filter }) => (filter === 'done' ? [] : todos),
    todo_clear: () => 0,
    // 发票台账：全是虚构的公司和号码
    invoice_sync: () => 0,
    invoice_list: ({ filter }) => {
      const B1 = X('光屿家居（杭州）有限公司', 'Lumen Home (Hangzhou) Co., Ltd.'), B2 = X('杭州知夏贸易有限公司', 'Hangzhou Zhixia Trading Co., Ltd.')
      const all = [
        { id: 1, number: '26332000001234567801', date: '2026-11-14', amount: 268000, tax: 15170, seller: X('杭州云栖酒店管理有限公司', 'Yunqi Hotel Management Co., Ltd.'), buyer: B1, kind: X('普通发票', 'General invoice'), source: 'xml', mails: 1, accounts: [2] },
        { id: 2, number: '26332000001234567802', date: '2026-11-12', amount: 39840, tax: 2255, seller: X('迅行出行科技有限公司', 'Swift Ride Technology Co., Ltd.'), buyer: B1, kind: X('普通发票', 'General invoice'), source: 'xml', mails: 2, accounts: [1, 2] },
        { id: 3, number: '26332000001234567803', date: '2026-11-10', amount: 12650, tax: 368, seller: X('浙江沪杭高速公路有限公司', 'Zhejiang Huhang Expressway Co., Ltd.'), buyer: B1, kind: X('通行费', 'Toll'), source: 'xml', mails: 1, accounts: [2] },
        { id: 4, number: '26332000001234567804', date: '2026-11-10', amount: 8800, tax: 256, seller: X('浙江沪杭高速公路有限公司', 'Zhejiang Huhang Expressway Co., Ltd.'), buyer: B1, kind: X('通行费', 'Toll'), source: 'xml', mails: 1, accounts: [2] },
        { id: 5, number: '26332000001234567805', date: '2026-11-08', amount: 1580000, tax: 181770, seller: X('宁波竹语包装材料有限公司', 'Ningbo Bamboo Packaging Co., Ltd.'), buyer: B2, kind: X('增值税专用发票', 'Special VAT invoice'), source: 'ofd', mails: 1, accounts: [1] },
        { id: 6, number: '', date: '2026-11-05', amount: null, tax: null, seller: X('上海南站餐饮服务有限公司', 'Shanghai South Station Catering Co., Ltd.'), buyer: '', kind: '', source: 'pdf', mails: 1, accounts: [3] },
        { id: 7, number: '26332000001234567807', date: '2026-10-28', amount: 56000, tax: 3170, seller: X('杭州印象快印有限公司', 'Hangzhou Impression Printing Co., Ltd.'), buyer: B2, kind: X('普通发票', 'General invoice'), source: 'pdf', mails: 1, accounts: [1] },
      ].map((r) => ({ needsCheck: !r.number || r.amount == null || !r.buyer, edited: false, hidden: false, hasPdf: true, ...r }))
      const f = filter || {}
      const inProject = (r, pid) => (pid === 1 ? r.buyer === B1 && r.date >= '2026-11-01' : pid === 2 ? r.buyer === B2 : true)
      const items = all.filter((r) => (f.buyer === undefined || r.buyer === f.buyer) && (f.seller === undefined || r.seller === f.seller) && (!f.accountId || r.accounts.includes(f.accountId))
        && (!f.from || r.date >= f.from) && (!f.to || r.date <= f.to) && (!f.onlyCheck || r.needsCheck) && (!f.q || (r.number + r.seller + r.buyer).includes(f.q)) && !f.hidden && inProject(r, f.project))
      const count = (k) => Object.entries(all.reduce((m, r) => ((m[k(r)] = (m[k(r)] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1])
      return { items, count: items.length, total: items.reduce((n, r) => n + (r.amount || 0), 0), noAmount: items.filter((r) => r.amount == null).length, buyers: count((r) => r.buyer), sellers: count((r) => r.seller),
        accounts: [[2, 4], [1, 3], [3, 1]], months: count((r) => r.date.slice(0, 7)).sort((a, b) => (a[0] < b[0] ? 1 : -1)), all: all.length, check: all.filter((r) => r.needsCheck).length, hidden: 0,
        projects: [{ id: 1, name: X('11 月报销', 'November expenses'), buyer: B1, seller: null, accounts: [], from: '2026-11-01', to: '2026-11-30' }, { id: 2, name: X('知夏贸易 · 采购', 'Zhixia · purchasing'), buyer: B2, seller: null, accounts: [1], from: '', to: '' }].map((p) => { const xs = all.filter((r) => inProject(r, p.id)); return { ...p, count: xs.length, total: xs.reduce((n, r) => n + (r.amount || 0), 0) } }) }
    },
    invoice_detail: ({ id }) => ({ sellerTax: '', buyerTax: '',
      files: id === 2 ? [{ id: 21, name: X('迅行出行电子发票.pdf', 'Swift Ride invoice.pdf'), ext: 'pdf', size: 75458, msgId: 100, role: 'invoice' }, { id: 22, name: X('迅行出行电子发票.xml', 'Swift Ride invoice.xml'), ext: 'xml', size: 4431, msgId: 100, role: 'invoice' }, { id: 23, name: X('迅行出行电子发票.pdf', 'Swift Ride invoice.pdf'), ext: 'pdf', size: 75458, msgId: 101, role: 'invoice' }]
        : [{ id: 11, name: X('电子发票.pdf', 'invoice.pdf'), ext: 'pdf', size: 68102, msgId: 100, role: 'invoice' }, { id: 12, name: X('电子发票.ofd', 'invoice.ofd'), ext: 'ofd', size: 16599, msgId: 100, role: 'invoice' }],
      extras: id === 2 ? [{ id: 24, name: X('迅行出行行程报销单.pdf', 'Swift Ride trip statement.pdf'), ext: 'pdf', size: 90722, msgId: 100, role: 'extra' }] : [],
      mails: id === 2 ? [{ msgId: 100, accountId: 2, subject: X('迅行出行电子发票及行程报销单', 'Swift Ride invoice and trip statement'), from: X('迅行出行', 'Swift Ride'), date: t(2 * D) }, { msgId: 101, accountId: 1, subject: X('转发：迅行出行电子发票', 'Fwd: Swift Ride invoice'), from: ME, date: t(1 * D) }]
        : [{ msgId: 100, accountId: 2, subject: X('您的电子发票已开具', 'Your invoice is ready'), from: X('开票服务', 'Invoicing'), date: t(1 * D) }] }),
    invoice_update: () => null,
    invoice_project_save: () => 1,
    invoice_project_delete: () => null,
    invoice_project_item: () => null,
    invoice_open: () => null,
    invoice_export: () => ['C:\\Users\\demo\\Downloads\\invoices.zip', 0],
    list_drafts: () => [],
    contacts: () => [],
    digest: () => ({
      reply: [msgs[0], msgs[2], msgs[11]].map((m) => item(m)),
      bills: [msgs[3], msgs[12]].map((m) => item(m)),
      todos: todos.slice(0, 4).map((x) => ({ id: x.id, msgId: x.msgId, text: x.text, due: x.due })),
      followups: [item({ ...msgs[11], fromName: 'Ahmed Al-Sayed', subject: 'Re: Quotation — kitchen storage (sent Oct 30)', aiSummary: X('你 10 月 30 日发的报价，对方 5 天没回', 'You sent a quote on Oct 30; no reply for 5 days') })],
      followupTotal: 3, bulkUnread: 9, newCount: 14,
    }),
    digest_overview: () => ({ text: EN ? 'The two sales inquiries matter most today: Marco in Italy wants a quote for 2,000 bamboo cutlery sets by Nov 20 and samples first, and Sarah in Germany liked the samples and is ready to order 600 oak trays once you confirm December delivery. At work, Finance needs two hotel receipts by Friday and the product team is waiting for your packaging pick today. Your credit card statement of $1,186.40 is due Nov 25.' : '今天最要紧的是两个外贸询盘：意大利的 Marco 要 2000 套竹餐具报价，11 月 20 日截止，还要先寄样；德国的 Sarah 对样品满意，准备下 600 件橡木托盘，等你确认 12 月交期。公司那边，财务催你周五前补两张发票，产品部等你今天选定包装稿。信用卡 11 月 25 日到期，应还 ¥8,426.50。', at: t(10 * 60e3) }),
    ai_draft: () => full(msgs[0]).ai.reply,
    has_ai_key: () => true,
    'plugin:window|is_maximized': () => false,
    'plugin:event|listen': () => Math.floor(Math.random() * 1e6),
  }

  let cb = 0
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    transformCallback: (f) => { const id = ++cb; window[`_${id}`] = f; return id },
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => {
      const h = handlers[cmd]
      return h ? JSON.parse(JSON.stringify(h(args || {}))) : null
    },
  }
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
})()

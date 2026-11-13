import { useEffect, useState } from 'react'
import { Icon } from '../icons'
import { useApp } from '../store'
import { api, errText, type Account, type Folder, type Rule, type RuleAction, type RuleCond } from '../lib/api'
import { ask } from '../lib/ask'
import { L } from '../lib/i18n'
import { Seg, Sheet, Switch } from '../ui'
import { folderName } from './Sidebar'

// 邮件规则：新邮件到达收件箱时按从上到下的顺序自动处理（在后台 rules.rs 执行）

const FIELD_LABEL: Record<RuleCond['field'], string> = { from: L('发件人', 'From'), to: L('收件人', 'To'), subject: L('主题', 'Subject'), attachment: L('附件', 'Attachment') }
const OP_LABEL: Record<RuleCond['op'], string> = { contains: L('包含', 'contains'), not_contains: L('不包含', 'does not contain'), equals: L('等于', 'is'), has: L('有附件', 'has attachments'), none: L('没有附件', 'has no attachments') }
// 规则不能移进这些文件夹（和后台 validate 一致）
const NO_MOVE_ROLES = ['inbox', 'trash', 'drafts', 'sent']
const field = { width: 'auto', height: 28, fontSize: 12.5 } as const

const accName = (a: Account) => a.label || a.email

function actionText(a: RuleAction, folders: Folder[], accountId: number | null): string {
  switch (a.kind) {
    case 'archive': return L('归档', 'archive')
    case 'junk': return L('移到垃圾邮件', 'move to Junk')
    case 'read': return L('标为已读', 'mark as read')
    case 'unread': return L('标为未读', 'mark as unread')
    case 'flag': return L('标为重点', 'flag')
    case 'unflag': return L('取消重点', 'unflag')
    case 'move': {
      const f = folders.find((x) => x.accountId === accountId && x.path === a.folder)
      return f ? L(`移动到「${folderName(f)}」`, `move to "${folderName(f)}"`) : L(`移动到「${a.folder}」（文件夹已不存在）`, `move to "${a.folder}" (folder no longer exists)`)
    }
  }
}

export function ruleSummary(r: Rule, accounts: Account[], folders: Folder[]): string {
  const acc = r.accountId == null ? L('所有账号', 'All accounts') : (() => { const a = accounts.find((x) => x.id === r.accountId); return a ? accName(a) : L('账号已删除', 'deleted account') })()
  const conds = r.conds.map((c) => c.field === 'attachment' ? OP_LABEL[c.op] : L(`${FIELD_LABEL[c.field]}${OP_LABEL[c.op]}「${c.value}」`, `${FIELD_LABEL[c.field]} ${OP_LABEL[c.op]} "${c.value}"`))
  const acts = r.actions.map((a) => actionText(a, folders, r.accountId))
  const joiner = r.matchAll ? L(' 且 ', ' and ') : L(' 或 ', ' or ')
  let s = `${acc} · ${conds.join(joiner)} → ${acts.join(L('，', ', '))}`
  if (r.stop) s += L('；不再执行后面的规则', '; stop processing more rules')
  return s
}

type Draft = {
  id: number; name: string; enabled: boolean; accountId: number | null; matchAll: boolean; conds: RuleCond[]; stop: boolean
  dest: '' | 'archive' | 'junk' | 'move'; folder: string; seen: '' | 'read' | 'unread'; flag: '' | 'flag' | 'unflag'
}

const blankCond = (): RuleCond => ({ field: 'from', op: 'contains', value: '' })

function toDraft(r: Rule | null): Draft {
  if (!r) return { id: 0, name: '', enabled: true, accountId: null, matchAll: true, conds: [blankCond()], stop: false, dest: '', folder: '', seen: '', flag: '' }
  const k = (kinds: string[]) => r.actions.find((a) => kinds.includes(a.kind))
  const d = k(['archive', 'junk', 'move'])
  return {
    id: r.id, name: r.name, enabled: r.enabled, accountId: r.accountId, matchAll: r.matchAll, conds: r.conds.length ? r.conds.map((c) => ({ ...c })) : [blankCond()], stop: r.stop,
    dest: (d?.kind as Draft['dest']) ?? '', folder: d?.kind === 'move' ? d.folder : '',
    seen: (k(['read', 'unread'])?.kind as Draft['seen']) ?? '', flag: (k(['flag', 'unflag'])?.kind as Draft['flag']) ?? '',
  }
}

function fromDraft(d: Draft): Rule {
  const actions: RuleAction[] = []
  if (d.dest) actions.push({ kind: d.dest, folder: d.dest === 'move' ? d.folder : '' })
  if (d.seen) actions.push({ kind: d.seen, folder: '' })
  if (d.flag) actions.push({ kind: d.flag, folder: '' })
  const conds = d.conds.map((c) => c.field === 'attachment' ? { ...c, value: '' } : { ...c, value: c.value.trim() })
  return { id: d.id, name: d.name.trim(), enabled: d.enabled, accountId: d.accountId, matchAll: d.matchAll, conds, actions, stop: d.stop }
}

export function Rules() {
  const s = useApp()
  const [list, setList] = useState<Rule[] | null>(null)
  const [edit, setEdit] = useState<Draft | null>(null)
  const load = () => api.rules().then(setList).catch((e) => s.toast(errText(e), { kind: 'err' }))
  useEffect(() => { load() }, [])

  const save = async (r: Rule) => {
    try { await api.ruleSave(r); await load(); return true } catch (e) { s.toast(errText(e), { kind: 'err' }); return false }
  }
  const move = async (i: number, dir: -1 | 1) => {
    if (!list) return
    const next = [...list]
    ;[next[i], next[i + dir]] = [next[i + dir], next[i]]
    setList(next)
    try { await api.ruleOrder(next.map((r) => r.id)) } catch (e) { s.toast(errText(e), { kind: 'err' }) }
    load()
  }
  const remove = async (r: Rule) => {
    if (!await ask(L(`删除规则「${r.name || '未命名规则'}」？`, `Delete the rule "${r.name || 'Untitled rule'}"?`))) return
    try { await api.ruleDelete(r.id); load() } catch (e) { s.toast(errText(e), { kind: 'err' }) }
  }

  return (
    <>
      <div><h1>{L('邮件规则', 'Mail rules')}</h1><p className="lead">{L('新邮件到达收件箱时，按从上到下的顺序自动处理；同一类动作以排在前面的规则为准。只对新到的邮件生效，规则在这台电脑上执行。', 'When new mail arrives in the inbox, rules run from top to bottom; for the same kind of action, the rule higher up wins. Rules only apply to newly arrived mail and run on this computer.')}</p></div>
      <section>
        <div className="group sq">
          {list && list.length === 0 && <div className="gr" style={{ color: 'var(--sec)', fontSize: 13 }}>{L('还没有规则。比如：发件人包含「github」→ 标为已读并归档。', 'No rules yet. For example: From contains "github" → mark as read and archive.')}</div>}
          {list?.map((r, i) => (
            <div key={r.id} className="gr" style={{ gap: 10, alignItems: 'center' }}>
              <Switch label={L('启用这条规则', 'Enable this rule')} on={r.enabled} onChange={(v) => save({ ...r, enabled: v })} />
              <div className="grow" style={{ opacity: r.enabled ? 1 : 0.55 }}>
                <div className="lbl truncate">{r.name || L('未命名规则', 'Untitled rule')}</div>
                <div className="sub" style={{ lineHeight: 1.45, wordBreak: 'break-word' }}>{ruleSummary(r, s.accounts, s.folders)}</div>
              </div>
              <div className="row" style={{ gap: 4, flexShrink: 0 }}>
                <button className="tb" aria-label={L('上移', 'Move up')} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="up" size={15} /></button>
                <button className="tb" aria-label={L('下移', 'Move down')} disabled={i === list.length - 1} onClick={() => move(i, 1)}><Icon name="down" size={15} /></button>
                <button className="btn sm sq" aria-label={L('编辑', 'Edit')} onClick={() => setEdit(toDraft(r))}>{L('编辑', 'Edit')}</button>
                <button className="btn sm sq" aria-label={L('复制', 'Duplicate')} onClick={() => save({ ...r, id: 0, name: (r.name || L('未命名规则', 'Untitled rule')) + L(' 副本', ' copy') })}>{L('复制', 'Duplicate')}</button>
                <button className="btn sm sq danger" aria-label={L('删除', 'Delete')} onClick={() => remove(r)}>{L('删除', 'Delete')}</button>
              </div>
            </div>
          ))}
        </div>
      </section>
      <div><button className="btn primary sq" onClick={() => setEdit(toDraft(null))}><Icon name="plus" size={15} />{L('新建规则', 'New rule')}</button></div>
      {edit && <RuleSheet init={edit} onClose={() => setEdit(null)} onSave={async (r) => { if (await save(r)) setEdit(null) }} />}
    </>
  )
}

function RuleSheet({ init, onClose, onSave }: { init: Draft; onClose: () => void; onSave: (r: Rule) => void }) {
  const s = useApp()
  const [d, setD] = useState<Draft>(init)
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }))
  const setCond = (i: number, p: Partial<RuleCond>) => setD((x) => ({ ...x, conds: x.conds.map((c, j) => j === i ? { ...c, ...p } : c) }))
  const folders = d.accountId == null ? [] : s.folders.filter((f) => f.accountId === d.accountId && !NO_MOVE_ROLES.includes(f.role))

  const submit = () => {
    if (d.conds.length === 0 || d.conds.some((c) => c.field !== 'attachment' && !c.value.trim())) { s.toast(L('每条条件都要填内容', 'Fill in every condition'), { kind: 'err' }); return }
    if (!d.dest && !d.seen && !d.flag) { s.toast(L('至少选一个动作', 'Choose at least one action'), { kind: 'err' }); return }
    if (d.dest === 'move' && !d.folder) { s.toast(L('选一个目标文件夹', 'Choose a target folder'), { kind: 'err' }); return }
    onSave(fromDraft(d))
  }

  const title = init.id ? L('编辑规则', 'Edit rule') : L('新建规则', 'New rule')
  return (
    <Sheet onClose={onClose} label={title} pinned>
      <div className="sh-head">
        <div className="grow"><h1>{title}</h1></div>
        <button className="tb" aria-label={L('关闭', 'Close')} onClick={onClose}><Icon name="x" /></button>
      </div>
      <div className="sh-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="lbl">{L('规则名', 'Rule name')}</span>
          <input className="field" maxLength={80} placeholder={L('比如：GitHub 通知', 'e.g. GitHub notifications')} value={d.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span className="lbl">{L('适用账号', 'Account')}</span>
          <select className="field" style={{ ...field, maxWidth: '100%' }} value={d.accountId ?? ''} onChange={(e) => {
            const v = e.target.value === '' ? null : Number(e.target.value)
            set({ accountId: v, ...(d.dest === 'move' ? { dest: v == null ? '' : 'move', folder: '' } : {}) })
          }}>
            <option value="">{L('所有账号', 'All accounts')}</option>
            {s.accounts.map((a) => <option key={a.id} value={a.id}>{a.label ? `${a.label} · ${a.email}` : a.email}</option>)}
          </select>
        </div>

        <div>
          <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            <span className="lbl">{L('条件', 'Conditions')}</span>
            <Seg small value={d.matchAll ? 'all' : 'any'} onChange={(v) => set({ matchAll: v === 'all' })} options={[['all', L('满足全部条件', 'Match all')], ['any', L('满足任一条件', 'Match any')]]} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {d.conds.map((c, i) => (
              <div key={i} className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <select className="field" style={field} aria-label={L('字段', 'Field')} value={c.field} onChange={(e) => {
                  const f = e.target.value as RuleCond['field']
                  const textOp = c.op === 'has' || c.op === 'none' ? 'contains' : c.op
                  setCond(i, { field: f, op: f === 'attachment' ? 'has' : textOp })
                }}>
                  {(['from', 'to', 'subject', 'attachment'] as const).map((f) => <option key={f} value={f}>{FIELD_LABEL[f]}</option>)}
                </select>
                <select className="field" style={field} aria-label={L('方式', 'Operator')} value={c.op} onChange={(e) => setCond(i, { op: e.target.value as RuleCond['op'] })}>
                  {(c.field === 'attachment' ? (['has', 'none'] as const) : (['contains', 'not_contains', 'equals'] as const)).map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
                </select>
                {c.field !== 'attachment' && <input className="field grow" style={{ height: 28, fontSize: 12.5, minWidth: 120 }} maxLength={200} aria-label={L('内容', 'Text')} placeholder={c.field === 'subject' ? L('主题里的字', 'Text in the subject') : L('名字或邮箱地址', 'Name or email address')} value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} />}
                {c.field === 'attachment' && <span className="grow" />}
                <button className="tb" aria-label={L('删除这条条件', 'Remove this condition')} disabled={d.conds.length <= 1} onClick={() => setD((x) => ({ ...x, conds: x.conds.filter((_, j) => j !== i) }))}><Icon name="x" size={14} /></button>
              </div>
            ))}
          </div>
          {d.conds.some((c) => c.field === 'attachment') && <div className="hint">{L('收到时按邮件头判断，个别带附件的邮件可能认不出', 'Judged from the headers on arrival; a few emails with attachments may be missed')}</div>}
          {d.conds.length < 10 && <button className="btn sm sq" style={{ marginTop: 8 }} onClick={() => setD((x) => ({ ...x, conds: [...x.conds, blankCond()] }))}><Icon name="plus" size={13} />{L('添加条件', 'Add condition')}</button>}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="lbl">{L('动作', 'Actions')}</span>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <select className="field" style={field} aria-label={L('去向', 'Move')} value={d.dest} onChange={(e) => set({ dest: e.target.value as Draft['dest'], folder: '' })}>
              <option value="">{L('不移动', "Don't move")}</option>
              <option value="archive">{L('归档', 'Archive')}</option>
              <option value="junk">{L('移到垃圾邮件', 'Move to Junk')}</option>
              <option value="move" disabled={d.accountId == null}>{d.accountId == null ? L('移动到文件夹（先选具体账号）', 'Move to folder (choose an account first)') : L('移动到文件夹', 'Move to folder')}</option>
            </select>
            {d.dest === 'move' && (
              <select className="field" style={{ ...field, maxWidth: 220 }} aria-label={L('目标文件夹', 'Target folder')} value={d.folder} onChange={(e) => set({ folder: e.target.value })}>
                <option value="">{L('选择文件夹…', 'Choose a folder…')}</option>
                {folders.map((f) => <option key={f.id} value={f.path}>{folderName(f)}</option>)}
                {d.folder && !folders.some((f) => f.path === d.folder) && <option value={d.folder}>{L(`${d.folder}（文件夹已不存在）`, `${d.folder} (folder no longer exists)`)}</option>}
              </select>
            )}
            <select className="field" style={field} aria-label={L('已读状态', 'Read status')} value={d.seen} onChange={(e) => set({ seen: e.target.value as Draft['seen'] })}>
              <option value="">{L('已读状态不改', "Don't change read status")}</option>
              <option value="read">{L('标为已读', 'Mark as read')}</option>
              <option value="unread">{L('标为未读', 'Mark as unread')}</option>
            </select>
            <select className="field" style={field} aria-label={L('重点', 'Flag')} value={d.flag} onChange={(e) => set({ flag: e.target.value as Draft['flag'] })}>
              <option value="">{L('重点不改', "Don't change flag")}</option>
              <option value="flag">{L('标为重点', 'Flag')}</option>
              <option value="unflag">{L('取消重点', 'Unflag')}</option>
            </select>
          </div>
          <div className="row" style={{ marginTop: 4 }}>
            <span className="grow" style={{ fontSize: 13 }}>{L('命中后不再执行后面的规则', 'Stop processing more rules after this one matches')}</span>
            <Switch label={L('命中后不再执行后面的规则', 'Stop processing more rules after this one matches')} on={d.stop} onChange={(v) => set({ stop: v })} />
          </div>
        </div>
      </div>
      <div className="sh-foot">
        <button className="btn sq" style={{ marginLeft: 'auto' }} onClick={onClose}>{L('取消', 'Cancel')}</button>
        <button className="btn primary sq" onClick={submit}>{L('保存', 'Save')}</button>
      </div>
    </Sheet>
  )
}

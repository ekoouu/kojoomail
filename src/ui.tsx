import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './icons'
import { avatarColors, initials } from './lib/format'
import { useApp } from './store'
import { L } from './lib/i18n'

export const isDark = () => document.documentElement.dataset.theme === 'dark'

export function Avatar({ name, email, badge, size }: { name: string; email: string; badge?: string; size?: 'sm' | 'md' }) {
  const [bg, fg] = avatarColors(email || name, isDark())
  return (
    <span className={`avatar${size === 'sm' ? ' sm' : ''}`} style={{ background: bg, color: fg }}>
      {initials(name, email)}
      {badge && <span className="badge" style={{ background: badge }} />}
    </span>
  )
}

const STROKES = [
  'M34 10 C31 34 25 60 19 86',
  'M23 70 C33 56 47 48 46 56 C45 63 31 66 27 68 C34 70 39 80 46 85 C48 86.5 50 86 52 84',
  'M77 58 C71 54 60 58 58 70 C56 82 68 87 74 79 C79 72 80 62 76 57 C80 59 84 58 88 55',
  'M101 56 C99 70 95 88 90 100 C87 107 78 107 74 101',
  'M131 58 C125 54 114 58 112 70 C110 82 122 87 128 79 C133 72 134 62 130 57 C134 59 138 58 142 55',
  'M159 58 C153 54 142 58 140 70 C138 82 150 87 156 79 C161 72 162 62 158 57 C162 59 166 58 170 55',
]

/** kojoo 笔画书写动画（加载中） */
export function Kojoo({ width = 120, stroke = 4.6, mail = false }: { width?: number; stroke?: number; mail?: boolean }) {
  const vbw = mail ? 240 : 180
  return (
    <svg className="kj" viewBox={`0 0 ${vbw} 110`} width={(width * vbw) / 180} height={(width * 110) / 180} role="img" aria-label={L('加载中', 'Loading')} style={{ overflow: 'visible' }}>
      <g>
        {STROKES.map((d, i) => <path key={i} className={`s${i}`} pathLength={1} d={d} style={{ strokeWidth: stroke }} />)}
        <circle className="kdot" cx={104} cy={43} r={stroke * 0.62} fill="currentColor" />
        {mail && <text className="mail" x={176} y={86} style={{ font: "italic 400 30px 'Instrument Serif', serif", fill: 'var(--sec)' }}>Mail</text>}
      </g>
    </svg>
  )
}

/** 加载不到 0.3 秒不显示，避免一闪 */
export function Loader({ text = L('正在加载…', 'Loading…'), width = 110 }: { text?: string; width?: number }) {
  return (
    <div className="loader">
      <Kojoo width={width} />
      {text && <div className="t">{text}</div>}
    </div>
  )
}

export function Empty({ icon, title, sub, children }: { icon: string; title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="glyph"><Icon name={icon} /></div>
      <h3>{title}</h3>
      {sub && <p>{sub}</p>}
      {children && <div style={{ marginTop: 14, display: 'flex', gap: 6 }}>{children}</div>}
    </div>
  )
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  const drop = useApp((s) => s.drop)
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.kind === 'err' ? ' err' : ''}${t.action ? '' : ' solo'}`}>
          <span>{t.text}</span>
          {t.action && <button onClick={() => { t.action!.run(); drop(t.id) }}>{t.action.label}</button>}
        </div>
      ))}
    </div>,
    document.body,
  )
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button className={`switch${on ? ' on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />
}

export function Seg<T extends string>({ value, options, onChange, small }: { value: T; options: [T, string][]; onChange: (v: T) => void; small?: boolean }) {
  return (
    <div className={`seg${small ? ' sm' : ''}${options.length > 5 ? ' dense' : ''}`} role="tablist">
      {options.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  )
}

export function Sheet({ children, onClose, className = '', label, pinned }: { children: ReactNode; onClose: () => void; className?: string; label: string; pinned?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [onClose])
  return createPortal(
    <div className="scrim" onMouseDown={(e) => { if (!pinned && e.target === e.currentTarget) onClose() }}>
      {pinned && <div className="scrim-drag" data-tauri-drag-region />}
      <div className={`sheet sq ${className}`} role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>,
    document.body,
  )
}

export type MenuItem = { label: string; icon?: string; key?: string; danger?: boolean; run: () => void } | 'sep'

export function useMenu() {
  const [m, setM] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const openAt = (x: number, y: number, items: MenuItem[]) => setM({ x: Math.min(x, innerWidth - 250), y, items })
  const openBelow = (el: HTMLElement, items: MenuItem[]) => {
    const r = el.getBoundingClientRect()
    openAt(Math.min(r.left, innerWidth - 250), r.bottom + 6, items)
  }
  const node = m ? <Menu {...m} onClose={() => setM(null)} /> : null
  return { openAt, openBelow, node }
}

function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(y)
  useEffect(() => {
    const h = ref.current?.offsetHeight || 0
    if (y + h > innerHeight - 8) setTop(Math.max(8, innerHeight - h - 8))
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    setTimeout(() => window.addEventListener('mousedown', down))
    window.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); window.removeEventListener('blur', onClose) }
  }, [y, onClose])
  return createPortal(
    <div className="menu sq" ref={ref} role="menu" style={{ left: x, top }}>
      {items.map((it, i) =>
        it === 'sep' ? <div key={i} className="sep" /> : (
          <button key={i} role="menuitem" className={it.danger ? 'danger' : ''} onClick={() => { onClose(); it.run() }}>
            {it.icon && <Icon name={it.icon} />}{it.label}{it.key && <span className="k">{it.key}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}

/**
 * 一行文字放不下（被 ellipsis 截断）时，悬浮显示全文
 * 提示框用 portal 挂在 body 上：不会被卡片的 overflow 裁掉，长句子换行、自动留在窗口内
 * 文字能放下就不显示，免得白冒一个多余的提示框
 */
export function TipText({ className, style, children }: { className?: string; style?: CSSProperties; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState('')
  const [tip, setTip] = useState<string | null>(null)
  const [pos, setPos] = useState<CSSProperties>({ left: 0, top: 0, visibility: 'hidden' })
  // 原生 title 只作兜底：悬浮时摘掉，免得和自绘提示同时弹两个
  useEffect(() => { setFull(ref.current?.textContent?.trim() ?? '') }, [children])
  const onMouseEnter = () => {
    const el = ref.current
    if (!el) return
    const text = el.textContent?.trim()
    // 从 DOM 读当前文本：调用处不用把同一句话再写一遍
    setTip(text && el.scrollWidth > el.clientWidth + 1 ? text : null)
  }
  useLayoutEffect(() => {
    const b = box.current, el = ref.current
    if (!tip || !b || !el) return
    const r = el.getBoundingClientRect()
    const w = b.offsetWidth, h = b.offsetHeight
    // 左对齐到文字起点，再夹在窗口内；下面放不下就改到文字上方
    const left = Math.min(Math.max(8, r.left), Math.max(8, innerWidth - w - 8))
    const top = r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6
    setPos({ left, top, visibility: 'visible' })
  }, [tip])
  return (
    <>
      <span ref={ref} className={className} title={tip ? undefined : full || undefined} style={{ display: 'block', ...style }} onMouseEnter={onMouseEnter} onMouseLeave={() => setTip(null)}>{children}</span>
      {tip && createPortal(<div className="tip-box" ref={box} style={pos}>{tip}</div>, document.body)}
    </>
  )
}

export const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement
  return t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable
}

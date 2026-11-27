// 写信用 Markdown：发送时转成排版好的 HTML（纯文本部分保留原文）。签名用的是同一套排版和清洗，所以格式和正文完全一样
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

// 白名单式清洗，和 Thunderbird、Roundcube（HTMLPurifier）、Mailspring（sanitize-html）一个路子：
// 标签、属性、CSS 属性、链接协议四层都只放行邮件排版用得上的，没列到的一律删。
// 读信那边关在 iframe 里，写信和签名的预览是直接塞进应用界面的，所以定位、层级、动画这类能盖住
// 窗口的 CSS 必须挡掉；url() 也一律不要，免得一段签名变成追踪像素或往外带数据。

const TAGS = [
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code',
  'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
  'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
]

// 通用属性：任何放行的标签都能带
const ATTRS = ['align', 'bgcolor', 'color', 'dir', 'height', 'lang', 'style', 'title', 'valign', 'width']
// 只对特定标签有意义的属性，挂到别的标签上就删掉
const ATTR_TAGS: Record<string, string[]> = {
  alt: ['img'], border: ['table', 'img'], cellpadding: ['table'], cellspacing: ['table'], checked: ['input'], disabled: ['input'],
  colspan: ['td', 'th'], face: ['font'], href: ['a'], reversed: ['ol'], rowspan: ['td', 'th'],
  size: ['font', 'hr'], src: ['img'], start: ['ol'], type: ['ol', 'ul', 'li', 'input'], value: ['li'],
}

// 只放行网页、邮件、电话协议和小体积的 base64 图片；相对地址在邮件里没意义，其余 data: 一概不要
const URI = /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpeg|jpg|gif|webp);base64,)/i
const MAX_DATA_URI = 256 * 1024

const SIDES = ['top', 'right', 'bottom', 'left']
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left']
const CSS_PROPS = new Set([
  'color', 'font', 'font-family', 'font-size', 'font-style', 'font-variant', 'font-weight',
  'letter-spacing', 'line-height', 'text-align', 'text-decoration', 'text-decoration-color',
  'text-decoration-line', 'text-decoration-style', 'text-indent', 'text-transform', 'text-shadow',
  'vertical-align', 'white-space', 'word-break', 'word-spacing', 'overflow-wrap', 'word-wrap',
  'direction', 'unicode-bidi',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'box-sizing',
  'aspect-ratio', 'object-fit',
  'background', 'background-color', 'border', 'border-width', 'border-style', 'border-color',
  'border-radius', 'border-collapse', 'border-spacing', 'box-shadow',
  'outline', 'outline-color', 'outline-style', 'outline-width',
  'table-layout', 'caption-side', 'empty-cells', 'list-style', 'list-style-type', 'list-style-position',
  'float', 'clear', 'display', 'overflow', 'overflow-x', 'overflow-y',
  ...SIDES.flatMap((s) => [`margin-${s}`, `padding-${s}`, `border-${s}`, `border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
  'margin', 'padding',
  ...CORNERS.map((c) => `border-${c}-radius`),
])

// 这几个属性的值再收一道：display:none 会把文字藏起来（预览和发出去的都藏），定位类的值根本不该出现
const CSS_VALUES: Record<string, Set<string>> = {
  display: new Set(['block', 'inline', 'inline-block', 'flow-root', 'table', 'table-row', 'table-cell', 'table-caption', 'list-item']),
  float: new Set(['left', 'right', 'none']),
  clear: new Set(['left', 'right', 'both', 'none']),
  overflow: new Set(['visible', 'hidden', 'auto', 'scroll']),
  'overflow-x': new Set(['visible', 'hidden', 'auto', 'scroll']),
  'overflow-y': new Set(['visible', 'hidden', 'auto', 'scroll']),
}

// url() 会往外发请求，image-set()、image()、cross-fade() 不写 url 也能带网址，一样不要；element()、paint() 邮件里用不上；
// var()/attr()/env() 邮箱不认、还会让预览和实际发出去的不一样；
// expression()、behavior、-moz-binding 是老 IE 的执行入口；反斜杠和注释是用来绕过关键字检查的；
// U+FFFD 是浏览器把 NUL 之类的控制字符换掉后留下的，同样不接受；
// vw/vh 这类视口单位在邮件里没意义，还会在预览里撑出横向滚动条
const BAD_VALUE = /url\s*\(|image-set\s*\(|image\s*\(|cross-fade\s*\(|element\s*\(|paint\s*\(|var\s*\(|attr\s*\(|env\s*\(|expression\s*\(|javascript:|vbscript:|behavior|-moz-binding|@import|\\|\/\*|\*\/|[\u0000-\u001f\u007f\ufffd]|\d+(?:\.\d+)?(?:vw|vh|vmin|vmax)\b/i

/** 只留下白名单里的 CSS 声明；DOMPurify 自己不校验 style 的值，这一层得我们做 */
function cleanCss(css: string): string {
  const out: string[] = []
  let len = 0
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':')
    if (i < 1) continue
    const prop = decl.slice(0, i).trim().toLowerCase()
    const value = decl.slice(i + 1).trim()
    if (!CSS_PROPS.has(prop) || !value || value.length > 512 || BAD_VALUE.test(value)) continue
    const allowed = CSS_VALUES[prop]
    if (allowed && !allowed.has(value.replace(/\s*!important\s*$/i, '').trim().toLowerCase())) continue
    if (len + prop.length + value.length > 8192) break
    len += prop.length + value.length
    out.push(`${prop}:${value}`)
    if (out.length >= 64) break
  }
  return out.join(';')
}

// 独立实例：钩子只作用于写信和签名，不碰读信那边 Reader.tsx 的清洗
const purify = DOMPurify(window)

purify.addHook('uponSanitizeAttribute', (node, e) => {
  if (e.attrName === 'style') {
    e.attrValue = cleanCss(e.attrValue)
    if (!e.attrValue) e.keepAttr = false
    return
  }
  const tags = ATTR_TAGS[e.attrName]
  if (tags && !tags.includes(node.nodeName.toLowerCase())) { e.keepAttr = false; return }
  if (e.attrName === 'src' || e.attrName === 'href') {
    // DOMPurify 对 img 的 data: 有内置放行（svg+xml 也在内），这里按自己的协议白名单再收一道
    if (!URI.test(e.attrValue)) { e.keepAttr = false; return }
    // 内嵌图片限长：签名里的 logo 用不了几百 KB，超大 base64 只会把邮件撑大
    if (/^data:/i.test(e.attrValue) && e.attrValue.length > MAX_DATA_URI) e.keepAttr = false
  }
})

purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
  if (node.nodeName === 'IMG' && !node.hasAttribute('alt')) node.setAttribute('alt', '')
  // input 只留一种：Markdown 任务列表（- [x]）排出来的勾选框，而且点不动。别的输入框一律删
  if (node.nodeName === 'INPUT') {
    if ((node.getAttribute('type') || '').toLowerCase() !== 'checkbox') node.parentNode?.removeChild(node)
    else node.setAttribute('disabled', '')
  }
})

const CONFIG = {
  ALLOWED_TAGS: TAGS,
  ALLOWED_ATTR: [...ATTRS, ...Object.keys(ATTR_TAGS)],
  ALLOWED_URI_REGEXP: URI,
  // DOMPurify 默认拿 URI 白名单去校验每个属性的值，border="0"、valign="top" 这种会被误删；
  // 这些属性本来就不是网址，声明成 URI 安全，协议白名单就只管 href 和 src
  ADD_URI_SAFE_ATTR: [...ATTRS, ...Object.keys(ATTR_TAGS)].filter((a) => a !== 'href' && a !== 'src'),
  ALLOW_DATA_ATTR: false,
}

// <style> 整段去掉：预览是直接放进界面里的，留着会把界面自己的样式也改掉（从别处粘来的 HTML 签名常带一段）。
// 发出去的也一样去掉，预览和实际发的才一致；样式写在标签的 style 属性里，各家邮箱也只认这种
const render = (md: string) => purify.sanitize(marked.parse(md, { async: false }) as string, CONFIG).trim()

/** 正文和签名之间的分隔：HTML 用一条细灰线（和别家客户端收到的观感一致），纯文本用 RFC 3676 的 "-- " 分隔行 */
export const SIG_RULE = '<div style="border-top:1px solid #d8d8d8;margin:18px 0 12px"></div>'

const BLOCKS = new Set(['P', 'DIV', 'TABLE', 'TR', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'DL', 'DT', 'DD', 'FIGURE', 'FIGCAPTION', 'CAPTION', 'CENTER'])

/** 排好版的 HTML 读成纯文字：一块一行，链接后面带上网址，图片只留说明文字 */
function htmlToText(html: string): string {
  let out = ''
  const line = () => { if (out && !out.endsWith('\n')) out += '\n' }
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      const t = (n.nodeValue || '').replace(/\s+/g, ' ')
      out += !out || out.endsWith('\n') ? t.trimStart() : t
      return
    }
    if (n.nodeType !== 1) return
    const el = n as Element
    const tag = el.nodeName
    if (tag === 'BR') { out += '\n'; return }
    if (tag === 'IMG') { out += el.getAttribute('alt') || ''; return }
    const block = BLOCKS.has(tag)
    if (block) line()
    if (tag === 'LI') out += '- '
    const from = out.length
    el.childNodes.forEach(walk)
    if (tag === 'A') {
      const href = (el.getAttribute('href') || '').replace(/^(?:mailto|tel):/i, '')
      const shown = out.slice(from).trim()
      if (href && shown && !href.includes(shown) && !shown.includes(href)) out += ` (${href})`
    }
    if (tag === 'TD' || tag === 'TH') out += '  '
    if (block) line()
  }
  walk(new DOMParser().parseFromString(html, 'text/html').body)
  return out.split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

let sigTextLast: [string, string] = ['', '']
/** 签名的纯文字版：邮件里给只看纯文字的收件人的那一份、存进「已发送」的摘要都用它。
 *  没写 HTML、没用 Markdown 链接和图片的签名原样用（和以前一样）；写了的排好版再读成文字，不把代码和图片那一长串字符发给人看 */
export function sigText(sig: string): string {
  if (!/<[a-z!/]|\]\(/i.test(sig)) return sig
  if (sigTextLast[0] !== sig) sigTextLast = [sig, htmlToText(render(sig))] // 写信时每敲一个字都会问一次，签名里有图片时排一遍不便宜
  return sigTextLast[1]
}

// 签名自己就以分隔线开头的（--、---、___、<hr>，老用户常这么写）：不再另加一道
const ownRule = (sig: string) => /^\s*(?:-{2,}|_{3,}|\*{3,}|<hr\b)/i.test(sig)

/** 纯文字版的整封信：正文，再接签名。rule：中间按 RFC 3676 加一行 "-- "。
 *  这一行后面的内容收件方的程序都当签名看（变灰、回复时去掉），所以后面还要接引用的原邮件时不能加，只空一行 */
export function textWithSig(body: string, sig: string, rule = true): string {
  const t = sig ? sigText(sig) : ''
  if (!t) return body
  if (!body.trim()) return t // 和 HTML 版一样：没有正文就不画分隔
  return `${body}\n\n${rule && !ownRule(sig) ? '-- \n' : ''}${t}`
}

// 正文、签名、引用各排各的再接起来：正文里没写完的代码块、没闭合的标签不会把签名和引用吞进去
function parts(body: string, sig: string, quote: string): string {
  return (body.trim() ? render(body) : '') + (sig.trim() ? (body.trim() && !ownRule(sig) ? SIG_RULE : '') + render(sig) : '') + (quote.trim() ? render(quote) : '')
}

const wrap = (inner: string) => `<div style="font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.6;color:#1F2A37">${inner}</div>`

/** 发出去的 HTML：正文 + 细线 + 签名 + 引用的原邮件 */
export function mailHtml(body: string, sig: string, quote = ''): string {
  return wrap(parts(body, sig, quote))
}

/** 写信页「预览」：和发出去的一样，只是不带引用（引用在下面单独折着） */
export function previewHtml(body: string, sig: string): string {
  return parts(body, sig, '')
}

// 签名里的图片是一长串字符，放在输入框里没法看也没法改：输入框里换成短名字（sig-image-1a2b3c4d），存的时候换回来。
// 名字按图片内容起、整个程序共用一张对照表：同一张图一直是同一个名字（删掉别的图不会变），
// 把一个账号的签名连着短名字复制到另一个账号也还认得
const DATA_IMG = /data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+/gi
const imgByName = new Map<string, string>()
const nameByImg = new Map<string, string>()
export function imageName(uri: string): string {
  const had = nameByImg.get(uri)
  if (had) return had
  let h = 0x811c9dc5
  for (let i = 0; i < uri.length; i++) h = Math.imul(h ^ uri.charCodeAt(i), 0x01000193)
  let name = `sig-image-${(h >>> 0).toString(16).padStart(8, '0')}`
  while (imgByName.has(name)) name += 'x' // 两张不同的图撞了名字
  imgByName.set(name, uri)
  nameByImg.set(uri, name)
  return name
}
export function foldImages(sig: string): string {
  return sig.replace(DATA_IMG, imageName)
}
// 只换写在图片地址位置上的（src="…" 和 Markdown 的 ](…)），别的地方出现同样的字是用户自己写的，不动
export function unfoldImages(text: string): string {
  return text.replace(/(src\s*=\s*["']?|\]\()(sig-image-[0-9a-f]{8}x*)/gi, (m, pre: string, name: string) => imgByName.has(name) ? pre + imgByName.get(name) : m)
}

export function mdToHtml(md: string) {
  return wrap(render(md))
}

export function mdPreview(md: string) {
  return render(md)
}

/** 回复时引用原文 */
export function quoteText(text: string, header: string) {
  const lines = text.split(/\r?\n/).slice(0, 200).map((l) => `> ${l}`)
  return `\n\n${header}\n${lines.join('\n')}`
}

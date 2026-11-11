// 写信用 Markdown：发送时转成排版好的 HTML（纯文本部分保留原文）。签名是拼在正文里一起转的，所以格式和正文完全一样
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
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
  'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
]

// 通用属性：任何放行的标签都能带
const ATTRS = ['align', 'bgcolor', 'color', 'dir', 'height', 'lang', 'style', 'title', 'valign', 'width']
// 只对特定标签有意义的属性，挂到别的标签上就删掉
const ATTR_TAGS: Record<string, string[]> = {
  alt: ['img'], border: ['table', 'img'], cellpadding: ['table'], cellspacing: ['table'],
  colspan: ['td', 'th'], face: ['font'], href: ['a'], reversed: ['ol'], rowspan: ['td', 'th'],
  size: ['font', 'hr'], src: ['img'], start: ['ol'], type: ['ol', 'ul', 'li'], value: ['li'],
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

// url() 会往外发请求；var()/attr()/env() 邮箱不认、还会让预览和实际发出去的不一样；
// expression()、behavior、-moz-binding 是老 IE 的执行入口；反斜杠和注释是用来绕过关键字检查的；
// U+FFFD 是浏览器把 NUL 之类的控制字符换掉后留下的，同样不接受；
// vw/vh 这类视口单位在邮件里没意义，还会在预览里撑出横向滚动条
const BAD_VALUE = /url\s*\(|var\s*\(|attr\s*\(|env\s*\(|expression\s*\(|javascript:|vbscript:|behavior|-moz-binding|@import|\\|\/\*|\*\/|[\u0000-\u001f\u007f\ufffd]|\d+(?:\.\d+)?(?:vw|vh|vmin|vmax)\b/i

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

export function withSignature(body: string, sig: string) {
  if (!sig) return { text: body, md: body }
  if (!body.trim()) return { text: sig, md: sig }
  return { text: `${body}\n\n-- \n${sig}`, md: `${body}\n\n${SIG_RULE}\n\n${sig}` }
}

export function mdToHtml(md: string) {
  return `<div style="font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.6;color:#1F2A37">${render(md)}</div>`
}

export function mdPreview(md: string) {
  return render(md)
}

/** 回复时引用原文 */
export function quoteText(text: string, header: string) {
  const lines = text.split(/\r?\n/).slice(0, 200).map((l) => `> ${l}`)
  return `\n\n${header}\n${lines.join('\n')}`
}

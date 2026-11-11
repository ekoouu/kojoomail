// 签名/正文的 Markdown + HTML 清洗：白名单该留的留、该删的删。
// 跑法：npm test（Node 22 用 --experimental-strip-types 直接读 src/lib/md.ts）
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

let mdPreview, mdToHtml, withSignature, DOMPurify

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  // md.ts 在模块加载时就用 window 建 DOMPurify 实例，得先把全局补上
  for (const k of ['window', 'document', 'Node', 'Element', 'NodeFilter', 'NamedNodeMap', 'DOMParser', 'HTMLFormElement', 'HTMLTemplateElement', 'DocumentFragment']) {
    globalThis[k] = k === 'window' ? dom.window : dom.window[k]
  }
  ;({ mdPreview, mdToHtml, withSignature } = await import('../src/lib/md.ts'))
  ;({ default: DOMPurify } = await import('dompurify'))
})

test('颜色：span 的 style、font 的 color、多个 CSS 属性都保留', () => {
  assert.equal(mdPreview('<span style="color:#C63E1F">红</span>'), '<p><span style="color:#C63E1F">红</span></p>')
  assert.equal(mdPreview('<font color="#1B4A80">蓝</font>'), '<p><font color="#1B4A80">蓝</font></p>')
  assert.equal(
    mdPreview('<span style="color:red;font-size:12px;background:#fff3e0">组合</span>'),
    '<p><span style="color:red;font-size:12px;background:#fff3e0">组合</span></p>',
  )
})

test('Markdown 和 HTML 混排：颜色里的 **加粗** 照常转', () => {
  assert.equal(
    mdPreview('你好，<span style="color:#1B4A80">**加粗又变蓝**</span>'),
    '<p>你好，<span style="color:#1B4A80"><strong>加粗又变蓝</strong></span></p>',
  )
  assert.equal(mdPreview('**加粗** 和 [链接](https://example.com)').includes('<strong>加粗</strong>'), true)
})

test('表格排版保留（签名常用）', () => {
  const html = mdPreview('<table border="0" cellpadding="4"><tr><td valign="top" style="padding-right:10px">A</td><td>B</td></tr></table>')
  // DOMPurify 倒着遍历属性再写回，顺序会变，只断言都在
  assert.match(html, /<table[^>]*\bborder="0"/)
  assert.match(html, /<table[^>]*\bcellpadding="4"/)
  assert.match(html, /<td[^>]*\bvalign="top"/)
  assert.match(html, /<td[^>]*style="padding-right:10px"[^>]*>A<\/td>/)
})

test('脚本、事件、危险标签一律删掉', () => {
  for (const bad of [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<div onclick="alert(1)">x</div>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="x"></object><embed src="x">',
    '<form action="https://evil.example"><input name="a"><button>go</button></form>',
    '<svg onload="alert(1)"></svg>',
    '<math><mtext></mtext></math>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<base href="https://evil.example">',
    '<link rel="stylesheet" href="https://evil.example/x.css">',
  ]) {
    const html = mdPreview(bad)
    assert.ok(!/<script|<iframe|<object|<embed|<form|<input|<button|<svg|<math|<meta|<base|<link|onerror|onclick|onload/i.test(html), `${bad} → ${html}`)
  }
})

test('<style> 整段删掉，里面的 CSS 不留在正文里', () => {
  assert.equal(mdPreview('<style>body{display:none}</style>\n\n正文'), '<p>正文</p>')
})

test('能盖住界面的 CSS 全删：定位、层级、变换、动画、隐藏', () => {
  const html = mdPreview('<div style="position:fixed;top:0;left:0;z-index:9999;transform:scale(3);animation:x 1s;display:none;visibility:hidden;opacity:0;color:red">x</div>')
  assert.equal(html, '<div style="color:red">x</div>')
})

test('视口单位删掉：100vw/100vh 会在预览里撑出滚动条', () => {
  assert.equal(mdPreview('<div style="width:100vw;height:100vh;background:#fff">x</div>'), '<div style="background:#fff">x</div>')
})

test('CSS 里的 url() 删掉：追踪像素和往外带数据的路都堵上', () => {
  for (const css of [
    "background:url('https://evil.example/p.gif')",
    "background-image:url('https://evil.example/p.gif')",
    "list-style-image:url('https://evil.example/p.gif')",
    "border-image:url('https://evil.example/p.gif')",
    "content:url('https://evil.example/p.gif')",
    "cursor:url('https://evil.example/p.gif'),auto",
  ]) {
    assert.equal(mdPreview(`<div style="${css};color:red">x</div>`), '<div style="color:red">x</div>', css)
  }
})

test('绕过手法删掉：var()、expression()、反斜杠、注释、控制字符', () => {
  for (const css of [
    'color:var(--accent)',
    'width:expression(alert(1))',
    'color:r\\65d',
    'color:re/**/d',
    'behavior:url(x.htc)',
    '-moz-binding:url(x.xml)',
  ]) {
    const html = mdPreview(`<div style="${css}">x</div>`)
    assert.ok(!/style=/.test(html), `${css} → ${html}`)
  }
  // NUL 被浏览器换成 U+FFFD：整条声明不要，定位更是无论如何都留不下
  const html = mdPreview('<div style="color:red\u0000;position:fixed;top:0">x</div>')
  assert.ok(!/position|top:|\ufffd/.test(html), html)
})

test('display 只放行排版用的值，none 不放行', () => {
  assert.equal(mdPreview('<span style="display:inline-block;color:red">x</span>'), '<p><span style="display:inline-block;color:red">x</span></p>')
  assert.equal(mdPreview('<span style="display:none">x</span>'), '<p><span>x</span></p>')
  assert.equal(mdPreview('<span style="display:flex">x</span>'), '<p><span>x</span></p>')
})

test('链接协议白名单：https/mailto/tel 留，javascript/data/vbscript 删', () => {
  assert.match(mdPreview('[网页](https://example.com)'), /href="https:\/\/example\.com"/)
  assert.match(mdPreview('[写信](mailto:a@example.com)'), /href="mailto:a@example\.com"/)
  assert.match(mdPreview('[电话](tel:+8613800000000)'), /href="tel:\+8613800000000"/)
  for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)', 'file:///c:/windows/win.ini']) {
    assert.ok(!/href=/.test(mdPreview(`<a href="${href}">x</a>`)), href)
  }
})

test('链接加固：target=_blank + rel=noopener noreferrer', () => {
  assert.equal(
    mdPreview('<a href="https://example.com">x</a>'),
    '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a></p>',
  )
})

test('属性按标签放行：href 只给 a，src 只给 img，class/id/data-* 一律删', () => {
  assert.equal(mdPreview('<div href="https://example.com">x</div>'), '<div>x</div>')
  assert.equal(mdPreview('<table><tr><td src="https://evil.example/p.gif">x</td></tr></table>'), '<table><tbody><tr><td>x</td></tr></tbody></table>')
  assert.equal(mdPreview('<div class="btn" id="app" data-x="1" style="color:red">x</div>'), '<div style="color:red">x</div>')
})

test('图片：https 和小体积 base64 留，超大 base64 删，缺 alt 自动补', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  assert.match(mdPreview(`<img src="${png}">`), /alt=""/)
  assert.match(mdPreview(`<img src="${png}">`), /src="data:image\/png;base64,/)
  assert.match(mdPreview('<img src="https://example.com/logo.png" width="120">'), /width="120"/)
  const huge = `data:image/png;base64,${'A'.repeat(300 * 1024)}`
  assert.ok(!/src=/.test(mdPreview(`<img src="${huge}">`)))
  assert.ok(!/src=/.test(mdPreview('<img src="data:image/svg+xml;base64,PHN2Zz4=">')))
})

test('CSS 声明数量和总长度有上限', () => {
  const many = Array.from({ length: 200 }, (_, i) => `margin-top:${i}px`).join(';')
  const html = mdPreview(`<div style="${many}">x</div>`)
  assert.ok((html.match(/margin-top/g) || []).length <= 64)
  const long = `color:${'r'.repeat(9000)}`
  assert.ok(!/style=/.test(mdPreview(`<div style="${long}">x</div>`)))
})

test('mdToHtml 外面套发信用的字体和颜色，预览不带这层', () => {
  const html = mdToHtml('<span style="color:red">x</span>')
  assert.match(html, /^<div style="font-family:-apple-system/)
  assert.match(html, /<span style="color:red">x<\/span>/)
  assert.equal(mdPreview('x'), '<p>x</p>')
})

test('空输入和纯空白不产出东西', () => {
  assert.equal(mdPreview(''), '')
  assert.equal(mdPreview('   \n  '), '')
})

test('正文和签名之间有分隔：HTML 一条细线，纯文本 RFC 3676 的 "-- "', () => {
  const { text, md } = withSignature('正文内容', '<span style="color:red">签名</span>')
  assert.equal(text, '正文内容\n\n-- \n<span style="color:red">签名</span>')
  const html = mdPreview(md)
  assert.match(html, /<div style="border-top:1px solid #d8d8d8;margin:18px 0 12px"><\/div>/)
  assert.ok(html.indexOf('正文内容') < html.indexOf('签名'))
  assert.equal(withSignature('', 'sig').text, 'sig')
  assert.equal(withSignature('body', '').text, 'body')
})

test('钩子只作用于写信这边：读信用的默认 DOMPurify 实例不受影响', () => {
  assert.equal(DOMPurify.sanitize('<div style="position:fixed;top:0">x</div>'), '<div style="position:fixed;top:0">x</div>')
})

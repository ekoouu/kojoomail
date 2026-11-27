// 签名/正文的 Markdown + HTML 清洗：白名单该留的留、该删的删。
// 跑法：npm test（Node 22 用 --experimental-strip-types 直接读 src/lib/md.ts）。
// jsdom 只有这个测试用，装在 tests/e2e 里（先在那儿 npm install），不进程序本身的依赖
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { JSDOM } = createRequire(new URL('./e2e/', import.meta.url))('jsdom')

let mdPreview, mdToHtml, sigText, textWithSig, mailHtml, previewHtml, foldImages, unfoldImages, DOMPurify

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  // md.ts 在模块加载时就用 window 建 DOMPurify 实例，得先把全局补上
  for (const k of ['window', 'document', 'Node', 'Element', 'NodeFilter', 'NamedNodeMap', 'DOMParser', 'HTMLFormElement', 'HTMLTemplateElement', 'DocumentFragment']) {
    globalThis[k] = k === 'window' ? dom.window : dom.window[k]
  }
  ;({ mdPreview, mdToHtml, sigText, textWithSig, mailHtml, previewHtml, foldImages, unfoldImages } = await import('../src/lib/md.ts'))
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
    '<input type="text" value="x"><input type="image" src="https://evil.example/x.png"><input type="submit">',
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
  const sig = '<span style="color:red">签名</span>'
  assert.equal(textWithSig('正文内容', sig), '正文内容\n\n-- \n签名')
  const html = previewHtml('正文内容', sig)
  assert.match(html, /<div style="border-top:1px solid #d8d8d8;margin:18px 0 12px"><\/div>/)
  assert.ok(html.indexOf('正文内容') < html.indexOf('签名'))
  assert.match(html, /<span style="color:red">签名<\/span>/)
  // 没有签名（或者这封不带）：什么都不加
  assert.equal(textWithSig('body', ''), 'body')
  assert.equal(previewHtml('body', ''), '<p>body</p>')
  // 正文是空的：不画那条线
  assert.ok(!previewHtml('', 'sig').includes('border-top'))
})

test('签名的纯文字版：普通签名原样用，写了 HTML 的读成文字，不把代码和图片发给人看', () => {
  assert.equal(sigText('张三\n电话 123  456\n**不动**'), '张三\n电话 123  456\n**不动**')
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const fancy = `<img src="${png}" width="80" alt="">\n<table><tr><td><b>张三</b></td><td>销售总监</td></tr><tr><td colspan="2">电话 <a href="tel:123">123</a> · <a href="https://kojoo.co">官网</a> · <a href="mailto:a@kojoo.co">a@kojoo.co</a></td></tr></table>`
  const t = sigText(fancy)
  assert.ok(!/[<>]|base64/.test(t), t)
  assert.equal(t, '张三  销售总监\n电话 123 · 官网 (https://kojoo.co) · a@kojoo.co')
  assert.equal(sigText('**张三** [官网](https://kojoo.co)\n第二行'), '张三 官网 (https://kojoo.co)\n第二行')
  // 只有一张图的签名：纯文字版里没东西可放，分隔行也不加
  assert.equal(textWithSig('正文', `<img src="${png}">`), '正文')
})

test('正文里没写完的代码块、没闭合的标签，不会把签名和引用吞进去', () => {
  for (const body of ['开头\n```\n没写完的代码', '<div><b>没闭合', '<table><tr><td>半张表']) {
    const html = mailHtml(body, '<span style="color:red">签名</span>', '\n\n在 1 月 1 日，某人 写道：\n> 原文')
    assert.match(html, /<div style="border-top:1px solid #d8d8d8;margin:18px 0 12px"><\/div><p><span style="color:red">签名<\/span><\/p><p>在 1 月 1 日，某人 写道：<\/p>\s*<blockquote>/, `${body} → ${html}`)
  }
  assert.match(mailHtml('正文', '', ''), /^<div style="font-family:-apple-system[^>]*><p>正文<\/p><\/div>$/)
})

test('签名输入框里图片显示成短名字：存的时候换回来，同一张图名字不变，换个账号也认得', () => {
  const a = 'data:image/png;base64,AAAA', b = 'data:image/jpeg;base64,BBBB+/=='
  const real = `<img src="${a}"> 文字 <img src="${b}" width="80"><img src="${a}">`
  const shown = foldImages(real)
  const names = shown.match(/sig-image-[0-9a-f]{8}/g)
  assert.equal(names.length, 3)
  assert.ok(names[0] === names[2] && names[0] !== names[1], shown)
  assert.ok(!shown.includes('base64'))
  assert.equal(unfoldImages(shown), real)
  // 删掉第一张，第二张的名字不变；只把短名字贴到别处（另一个账号的输入框）也换得回来
  assert.equal(foldImages(`<img src="${b}">`), `<img src="${names[1]}">`)
  assert.equal(unfoldImages(`<img src="${names[1]}">`), `<img src="${b}">`)
  // 没见过的名字原样留着（清洗时这个 src 会被删掉，不会往外发请求）
  assert.equal(unfoldImages('<img src="sig-image-00000000">'), '<img src="sig-image-00000000">')
  assert.ok(!mdPreview('<img src="sig-image-00000000">').includes('sig-image'))
})

test('CSS 里不写 url 也能带网址的函数（image-set 等）一样删掉', () => {
  for (const v of ["image-set('https://evil.example/a.png' 1x)", "-webkit-image-set('https://evil.example/a.png' 1x)", "image('https://evil.example/a.png')", "cross-fade('https://evil.example/a.png', red)"]) {
    for (const prop of ['background', 'list-style']) {
      const html = mdPreview(`<div style="${prop}:${v};color:red">x</div>`)
      assert.ok(!html.includes('evil.example') && html.includes('color:red'), `${prop}:${v} → ${html}`)
    }
  }
})

test('短名字只在图片地址的位置上换回来，正文里写到同样的字不动', () => {
  const u = 'data:image/png;base64,CCCC'
  const name = foldImages(u)
  assert.equal(unfoldImages(`<img src="${name}"> 说明：${name} 是图片 ![a](${name})`), `<img src="${u}"> 说明：${name} 是图片 ![a](${u})`)
  assert.equal(textWithSig('', '张三'), '张三')
})

test('任务列表的勾选框留着（点不动），别的输入框删掉', () => {
  const html = mdPreview('- [x] 做完了\n- [ ] 还没做')
  assert.equal((html.match(/<input/g) || []).length, 2, html)
  assert.match(html, /<input[^>]*checked[^>]*>\s*做完了/)
  assert.ok((html.match(/disabled/g) || []).length === 2 && (html.match(/type="checkbox"/g) || []).length === 2, html)
  assert.ok(!mdPreview('<input type="checkbox" onclick="alert(1)" name="a" value="b">').match(/onclick|name=|value=/))
})

test('后面还要接引用的原邮件时，纯文字版不加 "-- " 那一行；签名自带分隔线的不再加一道', () => {
  assert.equal(textWithSig('正文', '张三', false), '正文\n\n张三')
  assert.equal(textWithSig('正文', '张三'), '正文\n\n-- \n张三')
  for (const sig of ['--\n张三', '---\n张三', '<hr>\n\n张三']) {
    assert.ok(!textWithSig('正文', sig).includes('-- \n'), sig)
    assert.ok(!previewHtml('正文', sig).includes('border-top:1px solid #d8d8d8'), sig)
  }
})

test('钩子只作用于写信这边：读信用的默认 DOMPurify 实例不受影响', () => {
  assert.equal(DOMPurify.sanitize('<div style="position:fixed;top:0">x</div>'), '<div style="position:fixed;top:0">x</div>')
})

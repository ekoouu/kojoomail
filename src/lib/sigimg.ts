// 签名里的图片：从电脑上选一张，缩到签名用得上的大小，转成能直接写进签名的一串字符（data:）。
// 发信时后台会把它换成邮件的内嵌图片（smtp.rs 的 embed_data_images），对方不用点「显示图片」
import { L } from './i18n'

// md.ts 清洗时一张图最多 256 KB，留一点余量
const MAX_URI = 250 * 1024
// 签名里显示的大小：logo 一般就这么大；想调大调小改 width 的数字
const [BOX_W, BOX_H] = [280, 96]

const readDataUrl = (f: Blob) => new Promise<string>((ok, bad) => {
  const r = new FileReader()
  r.onload = () => ok(String(r.result))
  r.onerror = () => bad(r.error)
  r.readAsDataURL(f)
})

export async function signatureImage(file: File): Promise<{ uri: string; width: number }> {
  const bad = new Error(L('这个文件不是能用的图片（支持 PNG、JPG、GIF、WebP）', "This file isn't a usable image (PNG, JPG, GIF or WebP)"))
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw bad
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(bad); i.src = url })
    const [nw, nh] = [img.naturalWidth, img.naturalHeight]
    if (!nw || !nh) throw bad
    const k = Math.min(1, BOX_W / nw, BOX_H / nh)
    const [w, h] = [Math.max(1, Math.round(nw * k)), Math.max(1, Math.round(nh * k))]
    // 动图原样用（重画只剩第一帧），前提是不超限
    if (file.type === 'image/gif' && file.size * 1.4 < MAX_URI) return { uri: await readDataUrl(file), width: w }
    // 按显示大小的 2 倍存（高分屏上不糊），存不下就降到 1.5 倍、1 倍；PNG 太大（照片）换成 JPG
    for (const scale of [2, 1.5, 1]) {
      const cw = Math.max(1, Math.min(nw, Math.round(w * scale)))
      const ch = Math.max(1, Math.min(nh, Math.round(h * scale)))
      const c = document.createElement('canvas')
      c.width = cw; c.height = ch
      const g = c.getContext('2d')
      if (!g) throw bad
      g.imageSmoothingQuality = 'high'
      if (file.type !== 'image/jpeg') {
        g.drawImage(img, 0, 0, cw, ch)
        const png = c.toDataURL('image/png')
        if (png.length <= MAX_URI) return { uri: png, width: w }
      }
      g.fillStyle = '#fff' // JPG 没有透明，透明的地方按白底（发出去的信是白底）
      g.fillRect(0, 0, cw, ch)
      g.drawImage(img, 0, 0, cw, ch)
      const jpg = c.toDataURL('image/jpeg', 0.86)
      if (jpg.length <= MAX_URI) return { uri: jpg, width: w }
    }
    throw new Error(L('这张图片太大了，换一张小一点的', 'This image is too large. Try a smaller one.'))
  } finally { URL.revokeObjectURL(url) }
}

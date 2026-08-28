// core.js 是 UMD：浏览器/Worker 里挂 self.StickerSplit，Node（测试环境）里没有 self，
// 顶层 this 是 undefined 会在求值时抛错。本垫片必须作为独立模块先于 core.js 求值。
if (typeof (globalThis as { self?: unknown }).self === 'undefined') {
  ;(globalThis as { self?: unknown }).self = globalThis
}

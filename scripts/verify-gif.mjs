// 本地开发版本的完整 GIF 流程验证；拦截服务商请求，不产生真实生成费用。
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import gifenc from 'gifenc'
import sharp from 'sharp'

const url = process.argv[2] || 'http://127.0.0.1:5196/'
if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('此检查只支持本地开发服务器')
const out = path.resolve('output/playwright/gif-workbench')
await fs.mkdir(out, { recursive: true })
function createGif(frameCount = 9, duration = 200, variant = 0) {
  const encoder = gifenc.GIFEncoder()
  const side = 128
  for (let frame = 0; frame < frameCount; frame++) {
    const pixels = new Uint8Array(side * side)
    const x = 64 + Math.round(20 * Math.sin(frame * 2 * Math.PI / frameCount))
    for (let y = 0; y < side; y++) for (let px = 0; px < side; px++) pixels[y * side + px] = (px - x) ** 2 + (y - 64) ** 2 < 24 ** 2 ? 1 : 0
    encoder.writeFrame(pixels, side, side, { palette: [[250, 245, 239], [223 - variant * 12, 123, 87]], delay: duration, repeat: 0 })
  }
  encoder.finish()
  return Buffer.from(encoder.bytes())
}
// 可回放已取得的真实 GIF，验证兼容修复而不重复产生生成费用。
const bytes = process.env.GIF_TEST_ARTIFACT ? await fs.readFile(process.env.GIF_TEST_ARTIFACT) : createGif()
const expectedFrames = (await sharp(bytes, { animated: true }).metadata()).pages
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true })
const page = await context.newPage()
const errors = []
const requests = []
page.on('pageerror', (error) => errors.push(error.message))
let failNext = false
await page.route('**/*', async (route) => {
  const request = route.request()
  if (new URL(request.url()).pathname.endsWith('/announcements.json')) return route.fulfill({ contentType: 'application/json', body: '[]' })
  if (request.resourceType() === 'font') return route.abort()
  if (request.method() === 'POST' && request.url().includes('gif.example.test')) {
    const body = request.postDataJSON()
    requests.push(body)
    assert.ok(request.url().endsWith('/images/generations'))
    if (failNext) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'GIF preview access is required' } }) })
    if (requests.length === 1 && process.env.GIF_TEST_ARTIFACT) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC' }, { b64_json: bytes.toString('base64') }], output_format: 'png' }) })
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: Array.from({ length: body.n }, (_, i) => ({ b64_json: createGif(body.frame_count, body.frame_duration_ms, i).toString('base64') })), output_format: 'gif' }) })
  }
  return route.continue()
})
try {
  const startupReady = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/announcements.json'))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await startupReady
  await page.getByText('TaoStudio 生图工作台', { exact: true }).waitFor()
  await page.evaluate(async () => {
    // Vite 热更新会给模块附加时间戳，使用页面实际加载的模块以免创建第二个 store。
    const storeUrl = performance.getEntriesByType('resource').find((entry) => new URL(entry.name).pathname === '/src/store.ts')?.name
    if (!storeUrl) throw new Error('没有找到应用实际加载的 store 模块')
    const { useStore } = await import(storeUrl)
    const { normalizeSettings, DEFAULT_SETTINGS, createDefaultOpenAIProfile } = await import('/src/lib/apiProfiles.ts')
    const { DEFAULT_PARAMS } = await import('/src/types.ts')
    const profile = createDefaultOpenAIProfile({ id: 'gif-browser-test', name: 'GIF 流程测试', baseUrl: 'https://gif.example.test/v1', apiKey: 'test-placeholder', apiMode: 'responses', streamImages: true, apiProxy: false })
    useStore.setState({ settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id, activeScene: 'sticker' }), params: { ...DEFAULT_PARAMS }, prompt: '', inputImages: [], tasks: [] })
  })
  await page.getByRole('heading', { name: 'GIF 工作台', exact: true }).waitFor()
  assert.equal(await page.getByText('静态表情 / 头像快捷生成', { exact: true }).count(), 0)
  assert.equal(await page.getByText('战斗动图工坊（Sprite GIF）', { exact: true }).count(), 0)
  await page.getByLabel('动画描述', { exact: true }).fill('一盏纸灯笼轻轻摇晃，固定镜头，首尾自然衔接')
  await page.getByLabel('GIF 生成模型', { exact: true }).selectOption('gpt-image-2.6-sunburst')
  await page.getByRole('button', { name: '生成 GIF', exact: true }).click()
  const animation = page.getByAltText('生成的 GIF 动画', { exact: true })
  await animation.waitFor()
  await animation.evaluate((img) => img.decode())
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, 'gpt-image-2.6-sunburst')
  assert.equal(requests[0].frame_count, 9)
  for (const forbidden of ['stream', 'partial_images', 'output_compression', 'response_format', 'mask', 'image']) assert.equal(forbidden in requests[0], false)
  const stored = await page.evaluate(async () => {
    const { getAllTasks, getImage } = await import('/src/lib/db.ts')
    const task = (await getAllTasks()).find((item) => item.params.output_format === 'gif')
    const image = await getImage(task.outputImages[0])
    return { metadata: task.animation, dataUrl: image.dataUrl }
  })
  assert.equal(stored.metadata.frameCount, expectedFrames)
  assert.equal(stored.dataUrl, `data:image/gif;base64,${bytes.toString('base64')}`)
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 GIF 原件', exact: true }).click()
  const download = await downloadEvent
  const downloadedFile = path.join(out, download.suggestedFilename())
  await download.saveAs(downloadedFile)
  assert.deepEqual(await fs.readFile(downloadedFile), bytes)
  await page.screenshot({ path: path.join(out, 'desktop.png'), fullPage: true })
  await page.getByRole('button', { name: '停止预览', exact: true }).click()
  await page.getByAltText('GIF 静态封面', { exact: true }).waitFor()
  const firstReloadReady = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/announcements.json'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await firstReloadReady
  await page.getByRole('heading', { name: 'GIF 工作台', exact: true }).waitFor()
  await page.getByAltText('生成的 GIF 动画', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('GIF 生成模型', { exact: true }).inputValue(), 'gpt-image-2.6-sunburst')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('heading', { name: 'GIF 工作台', exact: true }).waitFor()
  const gifTab = await page.getByRole('button', { name: 'GIF 工作台', exact: true }).boundingBox()
  assert.ok(gifTab && gifTab.x >= 0 && gifTab.x + gifTab.width <= 390)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await page.screenshot({ path: path.join(out, 'mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1050 })
  await page.getByRole('button', { name: '深色', exact: true }).click()
  await page.screenshot({ path: path.join(out, 'dark.png'), fullPage: true })
  await page.getByLabel('GIF 帧数', { exact: true }).fill('64')
  await page.getByLabel('GIF 每帧时长', { exact: true }).fill('120')
  await page.getByLabel('GIF 每帧尺寸', { exact: true }).fill('256x256')
  await page.getByLabel('GIF 生成数量', { exact: true }).fill('2')
  await page.getByLabel('GIF 画质', { exact: true }).selectOption('max')
  await page.getByText('高级设置', { exact: true }).click()
  await page.getByLabel('GIF 规划强度', { exact: true }).selectOption('low')
  await page.getByLabel('GIF 内容审核', { exact: true }).selectOption('low')
  await page.getByRole('button', { name: '生成 GIF', exact: true }).click()
  await page.getByRole('button', { name: '动画 2', exact: true }).waitFor()
  await page.getByRole('button', { name: '动画 2', exact: true }).click()
  await page.getByAltText('生成的 GIF 动画', { exact: true }).waitFor()
  assert.deepEqual(Object.fromEntries(['frame_count', 'frame_duration_ms', 'n', 'size', 'quality', 'complexity', 'moderation'].map((key) => [key, requests[1][key]])), { frame_count: 64, frame_duration_ms: 120, n: 2, size: '256x256', quality: 'max', complexity: 'low', moderation: 'low' })
  const secondDownloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 GIF 原件', exact: true }).click()
  const secondDownload = await secondDownloadEvent
  const secondFile = path.join(out, secondDownload.suggestedFilename())
  await secondDownload.saveAs(secondFile)
  assert.deepEqual(await fs.readFile(secondFile), createGif(64, 120, 1))
  await page.screenshot({ path: path.join(out, 'configured.png'), fullPage: true })
  const secondReloadReady = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/announcements.json'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await secondReloadReady
  await page.getByRole('heading', { name: 'GIF 工作台', exact: true }).waitFor()
  assert.equal(await page.getByLabel('GIF 帧数', { exact: true }).inputValue(), '64')
  assert.equal(await page.getByLabel('GIF 生成数量', { exact: true }).inputValue(), '2')
  failNext = true
  await page.getByLabel('动画描述', { exact: true }).fill('没有权限时显示明确错误')
  await page.getByRole('button', { name: '生成 GIF', exact: true }).click()
  await page.getByText('GIF preview access is required', { exact: false }).first().waitFor()
  assert.equal(requests.length, 3)
  assert.deepEqual(errors, [])
  const report = { mockedProvider: true, realArtifactReplay: Boolean(process.env.GIF_TEST_ARTIFACT), requests: requests.length, frameCount: stored.metadata.frameCount, maxFramesConfigured: 64, multipleOutputs: true, preferencesRestored: true, originalBytesPreserved: true, downloadBytesPreserved: true, refreshRestored: true, mobileOverflow: false, pageErrors: errors, screenshots: ['desktop.png', 'mobile.png', 'dark.png', 'configured.png'] }
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true })
  console.error((await page.locator('body').innerText()).slice(-2000))
  throw error
} finally { await browser.close() }

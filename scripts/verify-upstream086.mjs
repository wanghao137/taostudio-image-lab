// v0.8.6 与 TaoStudio 自有创作入口的浏览器回归；模拟服务商，不产生生成费用。
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chromium } from 'playwright'
const url = process.argv[2] || 'http://127.0.0.1:5198/'
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('仅用于本地开发服务器')
const out = 'output/playwright/upstream086'
await fs.mkdir(out, { recursive: true })
const gif = (await fs.readFile('src/lib/__fixtures__/gif.ts', 'utf8')).match(/ANIMATED_GIF_BASE64 = '([^']+)'/)[1]
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="orange"/></svg>').toString('base64')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true })
page.setDefaultTimeout(60000)
const errors = [], requests = []
page.on('pageerror', (e) => errors.push(e.message))
await page.route('**/*', async (route) => {
  const request = route.request()
  if (new URL(request.url()).pathname.endsWith('/announcements.json')) return route.fulfill({ contentType: 'application/json', body: '[]' })
  if (request.resourceType() === 'font') return route.abort()
  if (request.method() === 'POST' && request.url().includes('upgrade.example.test')) {
    const body = request.postDataJSON()
    requests.push(body)
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: body.output_format === 'gif' ? gif : svg }], output_format: body.output_format }) })
  }
  return route.continue()
})
const waitDone = (count) => page.waitForFunction((expected) => window.__upgradeStore.getState().tasks.length === expected && window.__upgradeStore.getState().tasks.every((task) => task.status === 'done'), count)
try {
  const ready = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/announcements.json'))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await ready
  await page.getByText('TaoStudio 生图工作台', { exact: true }).waitFor()
  await page.evaluate(async () => {
    const storeUrl = performance.getEntriesByType('resource').find((e) => new URL(e.name).pathname === '/src/store.ts').name
    const { useStore } = await import(storeUrl)
    window.__upgradeStore = useStore
    const { normalizeSettings, DEFAULT_SETTINGS, createDefaultOpenAIProfile } = await import('/src/lib/apiProfiles.ts')
    const { DEFAULT_PARAMS } = await import('/src/types.ts')
    const profile = createDefaultOpenAIProfile({ id: 'upgrade-test', name: '升级回归', apiKey: 'test-placeholder', baseUrl: 'https://upgrade.example.test/v1', streamImages: true, apiProxy: false })
    useStore.setState({ settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id, activeScene: 'general' }), params: { ...DEFAULT_PARAMS }, tasks: [], inputImages: [], prompt: '加载圆环循环' })
  })
  await page.getByRole('button', { name: '展开参数', exact: true }).click()
  const formatControl = page.locator('label:visible').filter({ has: page.getByText('格式', { exact: true }) })
  await formatControl.getByText('PNG', { exact: true }).click()
  await page.getByText('GIF', { exact: true }).click()
  await page.getByRole('spinbutton', { name: '画廊 GIF 帧数', exact: true }).fill('12')
  await page.getByRole('spinbutton', { name: '画廊 GIF 每帧时长', exact: true }).fill('120')
  await page.getByRole('button', { name: '生成图像', exact: true }).click()
  await waitDone(1)
  assert.equal(requests.length, 1)
  assert.deepEqual(Object.fromEntries(['model', 'output_format', 'frame_count', 'frame_duration_ms'].map((key) => [key, requests[0][key]])), { model: 'gpt-image-2.6-sunburst', output_format: 'gif', frame_count: 12, frame_duration_ms: 120 })
  for (const key of ['stream', 'partial_images', 'output_compression']) assert.equal(key in requests[0], false)
  await page.screenshot({ path: `${out}/desktop-gif.png`, fullPage: true })
  await formatControl.getByText('GIF', { exact: true }).click()
  await page.getByText('SVG（仅文生图）', { exact: true }).click()
  await page.evaluate(() => { window.__upgradeStore.getState().setParams({ n: 2, exact_size: true, size: '4096x4096' }); window.__upgradeStore.getState().setPrompt('橙色矢量方块') })
  await page.getByRole('button', { name: '生成图像', exact: true }).click()
  await waitDone(2)
  assert.equal(requests.length, 3)
  for (const request of requests.slice(1)) {
    assert.deepEqual(request.svg, { model: 'gpt-6.1-sol' })
    assert.equal(request.output_format, 'svg')
    assert.equal('stream' in request, false)
  }
  const savedSvg = await page.evaluate(async () => {
    const { getImage } = await import('/src/lib/db.ts')
    const task = window.__upgradeStore.getState().tasks.find((t) => t.params.output_format === 'svg')
    return Promise.all(task.outputImages.map(async (id) => (await getImage(id)).dataUrl))
  })
  assert.deepEqual(savedSvg, [`data:image/svg+xml;base64,${svg}`, `data:image/svg+xml;base64,${svg}`])
  await page.screenshot({ path: `${out}/desktop-svg.png`, fullPage: true })
  await page.evaluate(() => window.__upgradeStore.getState().setParams({ output_format: 'png', n: 1, exact_size: false }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '创作', exact: true }).click()
  await page.getByRole('button', { name: '+ 更多', exact: true }).click()
  await page.getByRole('button', { name: 'GIF', exact: true }).click()
  await page.getByLabel('手机 GIF 帧数', { exact: true }).fill('16')
  await page.getByLabel('手机 GIF 每帧时长', { exact: true }).fill('240')
  await page.getByRole('button', { name: 'medium', exact: true }).click()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: `${out}/mobile-more.png`, fullPage: true })
  await page.mouse.click(10, 10)
  await page.getByRole('button', { name: '生成图像', exact: true }).click()
  await waitDone(3)
  assert.equal(requests.length, 4)
  assert.deepEqual(Object.fromEntries(['output_format', 'frame_count', 'frame_duration_ms', 'complexity'].map((key) => [key, requests[3][key]])), { output_format: 'gif', frame_count: 16, frame_duration_ms: 240, complexity: 'medium' })
  assert.deepEqual(errors, [])
  const report = { mockedProvider: true, desktopGif: true, svgOriginalPreserved: true, svgMultipleOutputs: true, mobileGif: true, mobileOverflow: false, requests, pageErrors: errors }
  await fs.writeFile(`${out}/report.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png`, fullPage: true })
  console.error((await page.locator('body').innerText()).slice(-1800))
  throw error
} finally { await browser.close() }

// 真实本地服务商验收，会产生生成请求；凭据仅从进程环境读取，不写入报告。
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium } from 'playwright'

const appUrl = process.argv[2] || 'http://127.0.0.1:5196/'
if (!['localhost', '127.0.0.1'].includes(new URL(appUrl).hostname)) throw new Error('仅允许测试本地工作台')
let credentials = process.env
if (process.argv.includes('--credentials-stdin')) {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  credentials = JSON.parse(input)
}
const out = path.resolve('output/gif-live-20261105/browser')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch()
const reports = []
const cases = [
  { port: 8090, model: 'gpt-image-2.6-flare', prompt: 'Create a seamless animated GIF of a small orange fox gently waving its paw on a cream background.' },
  { port: 3001, model: 'gpt-image-2.6-sunburst', prompt: 'Create a seamless animated GIF: a minimal blue circular loading indicator rotates smoothly on a clean white background. Flat vector icon, fixed camera.' },
]
try {
  for (const test of cases) {
    const key = credentials[`GIF_TEST_${test.port}_API_KEY`]
    if (!key) throw new Error(`缺少 ${test.port} 的测试凭据`)
    const sanitize = (value) => String(value).replaceAll(key, '[redacted]').replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/gi, '[redacted]')
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    const requests = []
    page.on('pageerror', (e) => errors.push(sanitize(e.message)))
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/images/generations')) requests.push(request.postDataJSON())
    })
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).pathname.endsWith('/announcements.json')) return route.fulfill({ contentType: 'application/json', body: '[]' })
      if (route.request().resourceType() === 'font') return route.abort()
      return route.continue()
    })
    const report = { port: test.port, model: test.model, realProvider: true }
    try {
      const ready = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/announcements.json'))
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
      await ready
      await page.getByText('TaoStudio 生图工作台', { exact: true }).waitFor()
      await page.evaluate(async ({ key, port }) => {
        const url = performance.getEntriesByType('resource').find((e) => new URL(e.name).pathname === '/src/store.ts')?.name
        const { useStore } = await import(url)
        window.__gifLiveStore = useStore
        const { normalizeSettings, DEFAULT_SETTINGS, createDefaultOpenAIProfile } = await import('/src/lib/apiProfiles.ts')
        const profile = createDefaultOpenAIProfile({ id: 'live-gif', name: `本地接口 ${port}`, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: key, apiMode: 'images', apiProxy: false })
        useStore.setState({ settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id, activeScene: 'sticker' }), tasks: [], prompt: '', inputImages: [] })
      }, { key, port: test.port })
      await page.getByRole('heading', { name: 'GIF 工作台', exact: true }).waitFor()
      await page.getByLabel('动画描述', { exact: true }).fill(test.prompt)
      await page.getByLabel('GIF 生成模型', { exact: true }).selectOption(test.model)
      await page.getByLabel('GIF 帧数', { exact: true }).fill('12')
      await page.getByLabel('GIF 每帧时长', { exact: true }).fill('150')
      await page.getByLabel('GIF 每帧尺寸', { exact: true }).fill('256x256')
      await page.getByRole('button', { name: '生成 GIF', exact: true }).click()
      await page.waitForFunction(() => {
        const task = window.__gifLiveStore.getState().tasks.find((t) => t.params.output_format === 'gif')
        return task && ['done', 'error'].includes(task.status)
      }, null, { timeout: 300000 })
      const actual = await page.evaluate(async () => {
        const task = window.__gifLiveStore.getState().tasks.find((t) => t.params.output_format === 'gif')
        const { getImage, getAllTasks } = await import('/src/lib/db.ts')
        const saved = (await getAllTasks()).find((t) => t.id === task.id)
        const image = task.outputImages[0] ? await getImage(task.outputImages[0]) : null
        return { status: task.status, error: task.error, metadata: task.animation, companions: task.gifCompanionCount, persisted: saved?.status === 'done', dataUrl: image?.dataUrl }
      })
      report.status = actual.status
      report.error = actual.error ? sanitize(actual.error).slice(0, 500) : null
      report.metadata = actual.metadata
      report.companions = actual.companions
      report.persisted = actual.persisted
      if (actual.status === 'done') {
        await page.getByAltText('生成的 GIF 动画', { exact: true }).evaluate((img) => img.decode())
        const downloaded = page.waitForEvent('download')
        await page.getByRole('button', { name: '下载 GIF 原件', exact: true }).click()
        const download = await downloaded
        const filename = path.join(out, `${test.port}-download.gif`)
        await download.saveAs(filename)
        const bytes = await fs.readFile(filename)
        assert.deepEqual(bytes, Buffer.from(actual.dataUrl.split(',')[1], 'base64'))
        report.downloadBytesPreserved = true
        report.sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
        report.parametersHonored = actual.metadata.frameCount === 12 && actual.metadata.frameDurationsMs.every((ms) => ms === 150) && actual.metadata.width === 256 && actual.metadata.height === 256
        await page.getByRole('button', { name: '停止预览', exact: true }).click()
        await page.getByAltText('GIF 静态封面', { exact: true }).evaluate((img) => img.decode())
        report.staticCoverDecoded = true
      }
      await page.screenshot({ path: path.join(out, `${test.port}-desktop.png`), fullPage: true })
      await page.setViewportSize({ width: 390, height: 844 })
      report.mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
      await page.screenshot({ path: path.join(out, `${test.port}-mobile.png`), fullPage: true })
    } catch (error) {
      report.status = 'verification-error'
      report.error = sanitize(error.message).slice(0, 500)
    } finally {
      report.requests = requests
      report.pageErrors = errors
      report.passed = report.status === 'done' && report.parametersHonored && report.downloadBytesPreserved && report.persisted && !report.mobileOverflow && !errors.length
      reports.push(report)
      await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(reports, null, 2))
      console.log(JSON.stringify(report, null, 2))
      await context.close()
    }
  }
} finally { await browser.close() }
if (reports.some((report) => !report.passed)) process.exitCode = 1

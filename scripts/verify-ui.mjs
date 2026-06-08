import fs from 'node:fs'
import { chromium } from 'playwright'

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage:
  npm run verify:ui -- [url]

Default URL:
  http://127.0.0.1:5175/
`)
  process.exit(0)
}

const url = process.argv[2] || 'http://127.0.0.1:5175/'
const screenshotDir = '.omx/screenshots'

fs.mkdirSync(screenshotDir, { recursive: true })

const forbiddenText = [
  ['INTERNAL', ' STUDIO', ' CONSOLE'].join(''),
  ['从 Prompt 到 ', '4K 成片，一屏完成。'].join(''),
  ['连接任意 ', 'OpenAI-compatible 图片接口，保留', '4K、自定义参数、历史任务和团队素材复用。'].join(''),
  ['C', 'PA'].join(''),
  ['CLI', 'Proxy'].join(''),
  ['Local ', 'C', 'PA'].join(''),
  ['本机 ', 'C', 'PA'].join(''),
]

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(
    () => document.body?.innerText.includes('TaoStudio 生图工作台'),
    undefined,
    { timeout: 60_000 },
  )
  await page.screenshot({ path: `${screenshotDir}/desktop-studio-console.png`, fullPage: true })

  const bodyText = await page.locator('body').innerText()
  const missingBrand = !bodyText.includes('TaoStudio 生图工作台')
  const forbiddenHits = forbiddenText.filter((item) => bodyText.includes(item))

  if (missingBrand) {
    throw new Error('TaoStudio 生图工作台 brand text was not found in the page body.')
  }

  if (forbiddenHits.length) {
    throw new Error(`Forbidden visible text found: ${forbiddenHits.join(', ')}`)
  }

  await page.locator('button[aria-label="深色"]').click()
  const darkTheme = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    mode: document.documentElement.dataset.themeMode,
    darkClass: document.documentElement.classList.contains('dark'),
  }))

  if (darkTheme.theme !== 'dark' || darkTheme.mode !== 'dark' || !darkTheme.darkClass) {
    throw new Error(`Dark theme did not apply correctly: ${JSON.stringify(darkTheme)}`)
  }

  await page.locator('button[aria-label="浅色"]').click()
  const lightTheme = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    mode: document.documentElement.dataset.themeMode,
    darkClass: document.documentElement.classList.contains('dark'),
  }))

  if (lightTheme.theme !== 'light' || lightTheme.mode !== 'light' || lightTheme.darkClass) {
    throw new Error(`Light theme did not apply correctly: ${JSON.stringify(lightTheme)}`)
  }

  await page.locator('button[aria-label="跟随系统"]').click()
  const systemMode = await page.evaluate(() => document.documentElement.dataset.themeMode)
  if (systemMode !== 'system') {
    throw new Error(`System theme mode did not apply correctly: ${systemMode}`)
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: `${screenshotDir}/mobile-studio-console.png`, fullPage: true })

  console.log('UI verification passed')
} finally {
  await browser.close()
}

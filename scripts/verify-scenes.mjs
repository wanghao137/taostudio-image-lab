// 场景冒烟浏览器门（npm run verify:scenes -- [url]）
// 覆盖：桌面场景 Tab + 引擎在位、Skill 工坊 lazy 视图、场景设置抽屉四分区、无限画布外链、
// 引擎视图可达、移动端场景 chips，以及整页控制台错误为零
// （防线核心：场景过滤选择器若返回新引用会触发 React 19
// "Maximum update depth exceeded"，此处 console/pageerror 捕获即 FAIL）。
import fs from 'node:fs'
import { chromium } from 'playwright'

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage:
  npm run verify:scenes -- [url]

Default URL:
  http://127.0.0.1:5175/
`)
  process.exit(0)
}

const url = process.argv[2] || 'http://127.0.0.1:5175/'
const screenshotDir = '.omx/screenshots'
fs.mkdirSync(screenshotDir, { recursive: true })

const browser = await chromium.launch()
const errors = []
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  // 本门的核心防线是 React 崩溃类错误（pageerror / “Maximum update depth”
  // / “getSnapshot should be cached” 等 console error）。浏览器网络层的
  // “Failed to load resource: ...”（如本机引擎 /v1/capabilities 探测在
  // 无凭证/未启动时的 401 或 connection refused）与本门无关且随环境波动，
  // 记为 WARN 不计 FAIL；应用代码自身的 console error 与 pageerror 仍全部致命。
  const networkErrors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    if (msg.text().startsWith('Failed to load resource:')) networkErrors.push(msg.text())
    else errors.push('console: ' + msg.text())
  })

const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1 }
const warn = (m) => console.warn('WARN: ' + m)

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => document.body?.innerText.includes('TaoStudio 生图工作台'), undefined, { timeout: 60000 })

  // 检查点1: 桌面场景 Tab + 引擎在位；智能体 Tab 已不在主导航
  for (const label of ['人像写真', '通用创作', '表情与头像', 'Skill 工坊', '引擎']) {
    if (!(await page.getByRole('button', { name: label, exact: true }).count())) fail(`桌面 Tab 缺失: ${label}`)
  }
  if (await page.getByRole('button', { name: '智能体', exact: true }).count()) fail('桌面仍存在智能体 Tab')

  // 检查点2: Skill 工坊 lazy 视图在位 + 工坊内场景设置抽屉四分区
  // 工坊视图是 lazy chunk、内置 skill 列表也要异步 fetch：轮询最多 5s，
  // 缺失只 fail 不抛异常，避免中断后续检查点。扩写入口两种形态都容忍：
  // 有文本 profile → 「扩写提示词」按钮；无 profile → noProfile 引导文案。
  await page.getByRole('button', { name: 'Skill 工坊', exact: true }).first().click()
  let bodyWorkshop = ''
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(250)
    bodyWorkshop = await page.locator('body').innerText()
    if ((await page.getByRole('heading', { name: 'Skill 工坊' }).count()) && bodyWorkshop.includes('vibeshot-candid-photography')) break
  }
  if (!(await page.getByRole('heading', { name: 'Skill 工坊' }).count())) fail('工坊 lazy 视图未加载（「Skill 工坊」标题缺失）')
  if (!(bodyWorkshop.includes('扩写提示词') || bodyWorkshop.includes('未找到可用的文本模型配置'))) fail('工坊扩写入口缺失（既无「扩写提示词」也无 noProfile 引导文案）')
  if (!bodyWorkshop.includes('vibeshot-candid-photography')) fail('内置 skill 名缺失: vibeshot-candid-photography')
  await page.screenshot({ path: `${screenshotDir}/scene-smoke-skill-workshop.png` })
  const workshopGear = page.getByRole('button', { name: '场景设置' }).first()
  if (!(await workshopGear.count())) {
    fail('工坊内场景设置齿轮缺失')
  } else {
    await workshopGear.click()
    await page.waitForTimeout(600)
    const bodyWorkshopDrawer = await page.locator('body').innerText()
    for (const s of ['生图模型', '保存目录', '文本模型', '默认参数']) {
      if (!bodyWorkshopDrawer.includes(s)) fail(`工坊场景设置抽屉分区缺失: ${s}`)
    }
    await page.getByRole('button', { name: '关闭' }).first().click()
    await page.waitForTimeout(200)
  }
  await page.getByRole('button', { name: '通用创作', exact: true }).first().click()
  await page.waitForTimeout(300)

  // 检查点3: 点场景 → 画廊头部「一键全部」切换 chip → 齿轮开抽屉 → 四分区在位
  // 齿轮缺失时只 fail 不继续点击，避免对不存在元素 click 抛异常中断后续检查点
  await page.getByRole('button', { name: '人像写真', exact: true }).first().click()
  await page.waitForTimeout(300)
  const sceneScopeChip = page.getByRole('button', { name: '全部', exact: true }).first()
  if (!(await sceneScopeChip.count())) {
    fail('画廊头部「全部」切换 chip 缺失')
  } else {
    await sceneScopeChip.click()
    await page.waitForTimeout(200)
    if (!(await page.getByRole('button', { name: '仅人像写真', exact: true }).count())) fail('切到全部后未显示「仅人像写真」')
    await page.getByRole('button', { name: '仅人像写真', exact: true }).first().click()
    await page.waitForTimeout(200)
    if (!(await page.getByRole('button', { name: '全部', exact: true }).count())) fail('切回场景后未显示「全部」')
  }
  const gear = page.getByRole('button', { name: '场景设置' }).first()
  if (!(await gear.count())) {
    fail('场景设置齿轮缺失')
  } else {
    await gear.click()
    await page.waitForTimeout(600)
    const body = await page.locator('body').innerText()
    for (const s of ['生图模型', '保存目录', '文本模型', '默认参数']) {
      if (!body.includes(s)) fail(`抽屉分区缺失: ${s}`)
    }
    await page.getByRole('button', { name: '关闭' }).first().click()
    await page.waitForTimeout(200)
  }

  // 检查点4: 无限画布外链图标在头部右侧（可定位 + 绝对 URL）
  const canvas = page.getByRole('link', { name: '无限画布' }).first()
  if (!(await canvas.count())) fail('桌面无限画布入口缺失')
  const href = await canvas.getAttribute('href')
  if (!href || !/^https?:\/\//.test(href)) fail(`无限画布 href 异常: ${href}`)

  // 检查点5: 引擎可达 + 回场景
  await page.getByRole('button', { name: '引擎', exact: true }).first().click()
  await page.waitForTimeout(800)
  if (!(await page.locator('body').innerText()).includes('批量')) warn('引擎视图未见「批量」字样（人工看截图确认）')
  await page.screenshot({ path: `${screenshotDir}/scene-smoke-engine.png` })
  await page.getByRole('button', { name: '通用创作', exact: true }).first().click()
  await page.waitForTimeout(300)

  // 检查点6: 移动 375px 场景 chips + 引擎可达
  await page.setViewportSize({ width: 375, height: 812 })
  await page.waitForTimeout(500)
  const bodyMobile = await page.locator('body').innerText()
  for (const label of ['人像写真', '通用创作', '表情与头像', 'Skill 工坊', '引擎']) {
    if (!bodyMobile.includes(label)) fail(`移动端缺失: ${label}`)
  }
  await page.screenshot({ path: `${screenshotDir}/scene-smoke-mobile.png` })

  if (errors.length) fail('控制台/页面错误: ' + errors.slice(0, 5).join(' | '))
  if (networkErrors.length) warn(`网络资源加载失败（环境相关，不致 FAIL）: ${networkErrors.slice(0, 3).join(' | ')}`)
  console.log(process.exitCode ? 'SCENE SMOKE FAILED' : 'SCENE SMOKE PASSED')
} finally {
  await browser.close()
}

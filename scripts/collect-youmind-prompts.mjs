import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { COMMON_SIZE_PRESETS } from '../packages/image-job-core/index.mjs'

const outputRoot = process.argv[2] ? resolve(process.argv[2]) : null
const requestedCount = Number(process.argv[3] || 50)
if (!outputRoot || !Number.isInteger(requestedCount) || requestedCount < 1) {
  throw new Error('usage: node scripts/collect-youmind-prompts.mjs <output-directory> [count]')
}

const inputRoot = resolve(outputRoot, 'inputs')
const promptRoot = resolve(inputRoot, 'prompts')
await mkdir(promptRoot, { recursive: true })

const detailPattern = /\/zh-CN\/prompts\/[^/]+-\d+$/
const copyLabel = '\u590d\u5236\u63d0\u793a\u8bcd'
const originalLabel = '\u7ffb\u8bd1\u524d'
const sourceIndex = 'https://youmind.com/zh-CN/gpt-image-2-prompts/explore'
const ratios = ['1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '21:9']
const routes = ['api', 'mcp', 'skill']

function slugFromUrl(url) {
  return new URL(url).pathname.split('/').filter(Boolean).at(-1)
}

function classifyContent(categories, title, prompt) {
  const joined = `${categories.join(' ')} ${title} ${prompt}`.toLowerCase()
  if (/app-web-design|ui|interface|webpage/.test(joined)) return 'ui'
  if (/text-typography|infographic|diagram-chart|poster-flyer|youtube-thumbnail/.test(joined)) return 'text'
  if (/logo/.test(joined)) return 'logo'
  if (/illustration|anime-manga|comic|chibi|pixel-art|watercolor|oil-painting|ink-chinese/.test(joined)) return 'illustration'
  return 'photo'
}

function needsReference(prompt) {
  return /(uploaded image|reference image|reference_\d|use the provided|\u4e0a\u4f20\u7684\u56fe\u50cf|\u53c2\u8003\u56fe)/i.test(prompt)
}

async function collectSeedLinks(page, url = sourceIndex) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  let previousCount = 0
  let stableRounds = 0
  for (let round = 0; round < 30 && stableRounds < 4; round += 1) {
    await page.mouse.wheel(0, 2200)
    await page.waitForTimeout(500)
    const count = await page.locator('a').evaluateAll((anchors, pattern) => anchors
      .map((anchor) => anchor.href)
      .filter((href) => new RegExp(pattern).test(new URL(href).pathname)).length, detailPattern.source)
    stableRounds = count === previousCount ? stableRounds + 1 : 0
    previousCount = count
  }
  return page.locator('a').evaluateAll((anchors, pattern) => [...new Set(anchors
    .map((anchor) => anchor.href)
    .filter((href) => new RegExp(pattern).test(new URL(href).pathname)))], detailPattern.source)
}

async function readPromptPage(context, url) {
  const page = await context.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(250)
    return await page.evaluate(({ copyLabel, originalLabel, detailPatternSource }) => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => {
          const text = candidate.textContent?.trim() || ''
          return text.includes(copyLabel) || text.includes(originalLabel)
        })
      let prompt = ''
      let cursor = button
      while (cursor && cursor !== document.body) {
        const text = cursor.nextElementSibling?.textContent?.trim() || ''
        if (text.length >= 30) {
          prompt = text
          break
        }
        cursor = cursor.parentElement
      }
      const categories = [...document.querySelectorAll('a[href*="gpt-image-2-prompts?categories="]')]
        .map((anchor) => new URL(anchor.href).searchParams.get('categories'))
        .filter(Boolean)
      const related = [...new Set([...document.querySelectorAll('a')]
        .map((anchor) => anchor.href)
        .filter((href) => new RegExp(detailPatternSource).test(new URL(href).pathname)))]
      return {
        title: document.querySelector('h1')?.textContent?.trim() || document.title,
        prompt,
        categories: [...new Set(categories)],
        related,
      }
    }, { copyLabel, originalLabel, detailPatternSource: detailPattern.source })
  } finally {
    await page.close()
  }
}

function selectDiverse(records, count) {
  const eligible = records.filter((record) => !record.requiresReference)
  const buckets = new Map()
  for (const record of eligible) {
    const key = record.categories[0] || 'uncategorized'
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(record)
  }
  const selected = []
  while (selected.length < count) {
    let added = false
    for (const bucket of buckets.values()) {
      const record = bucket.shift()
      if (!record) continue
      selected.push(record)
      added = true
      if (selected.length === count) break
    }
    if (!added) break
  }
  return selected
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ locale: 'zh-CN' })
const seedPage = await context.newPage()
const queue = await collectSeedLinks(seedPage)
await seedPage.close()
console.log(`Collected ${queue.length} seed prompt links.`)
const seen = new Set(queue)
const records = []
const scannedCategories = new Set()
const crawlLimit = Math.max(requestedCount * 3, 120)

try {
  while (records.length < crawlLimit) {
    if (!queue.length) {
      const category = records.flatMap((record) => record.categories)
        .find((candidate) => !scannedCategories.has(candidate))
      if (!category) break
      scannedCategories.add(category)
      const categoryPage = await context.newPage()
      const categoryUrl = `https://youmind.com/zh-CN/gpt-image-2-prompts?categories=${encodeURIComponent(category)}`
      const categoryLinks = await collectSeedLinks(categoryPage, categoryUrl)
      await categoryPage.close()
      for (const link of categoryLinks) {
        if (!seen.has(link)) {
          seen.add(link)
          queue.push(link)
        }
      }
      console.log(`Added ${queue.length} new links from category ${category}.`)
      if (!queue.length) continue
    }
    const batch = queue.splice(0, 3)
    const results = await Promise.all(batch.map(async (url) => ({ url, ...(await readPromptPage(context, url)) })))
    for (const result of results) {
      for (const related of result.related) {
        if (!seen.has(related)) {
          seen.add(related)
          queue.push(related)
        }
      }
      if (result.prompt.length < 30) continue
      records.push({
        sourceUrl: result.url,
        slug: slugFromUrl(result.url),
        title: result.title,
        prompt: result.prompt,
        categories: result.categories,
        requiresReference: needsReference(result.prompt),
      })
    }
    console.log(`Crawled ${records.length} complete prompts; queue=${queue.length}.`)
    const ready = selectDiverse(records, requestedCount)
    if (ready.length >= requestedCount && records.length >= requestedCount + 20) break
  }
} finally {
  await browser.close()
}

const selected = selectDiverse(records, requestedCount)
if (selected.length < requestedCount) {
  throw new Error(`only ${selected.length} standalone prompts were collected from ${records.length} detail pages`)
}

const tasks = []
for (let index = 0; index < selected.length; index += 1) {
  const record = selected[index]
  const id = String(index + 1).padStart(3, '0')
  const ratio = ratios[index % ratios.length]
  const route = routes[index % routes.length]
  const promptFile = resolve(promptRoot, `${id}-${record.slug}.txt`)
  await writeFile(promptFile, `${record.prompt}\n`, 'utf8')
  tasks.push({
    id,
    ...record,
    promptFile,
    route,
    ratio,
    dimensions: COMMON_SIZE_PRESETS['4K'][ratio],
    quality: 'high',
    format: 'png',
    contentClass: classifyContent(record.categories, record.title, record.prompt),
  })
}

const manifest = {
  version: 1,
  source: sourceIndex,
  collectedAt: new Date().toISOString(),
  requestedCount,
  crawledDetailPages: records.length,
  excludedReferenceDependent: records.filter((record) => record.requiresReference).length,
  tasks,
}
await writeFile(resolve(inputRoot, 'youmind-prompts.json'), JSON.stringify(manifest, null, 2), 'utf8')
console.log(JSON.stringify({
  output: resolve(inputRoot, 'youmind-prompts.json'),
  selected: tasks.length,
  crawled: records.length,
  categories: [...new Set(tasks.flatMap((task) => task.categories))].sort(),
  routes: Object.fromEntries(routes.map((route) => [route, tasks.filter((task) => task.route === route).length])),
  ratios: Object.fromEntries(ratios.map((ratio) => [ratio, tasks.filter((task) => task.ratio === ratio).length])),
}, null, 2))

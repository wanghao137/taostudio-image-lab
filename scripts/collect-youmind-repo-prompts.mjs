import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { COMMON_SIZE_PRESETS } from '../packages/image-job-core/index.mjs'

const outputRoot = process.argv[2] ? resolve(process.argv[2]) : null
const repositoryRoot = process.argv[3] ? resolve(process.argv[3]) : null
const requestedCount = Number(process.argv[4] || 50)
if (!outputRoot || !repositoryRoot || !Number.isInteger(requestedCount) || requestedCount < 1) {
  throw new Error('usage: node scripts/collect-youmind-repo-prompts.mjs <output-directory> <repository-directory> [count]')
}

const inputRoot = resolve(outputRoot, 'inputs')
const promptRoot = resolve(inputRoot, 'prompts')
await mkdir(promptRoot, { recursive: true })

const markdown = await readFile(resolve(repositoryRoot, 'README_zh.md'), 'utf8')
const sectionMarker = '## \ud83d\udccb \u6240\u6709\u63d0\u793a\u8bcd'
const allPrompts = markdown.slice(markdown.indexOf(sectionMarker))
if (!allPrompts) throw new Error('README_zh.md does not contain the all-prompts section')

function needsReference(prompt) {
  return /(uploaded image|reference image|reference_\d|use the provided|\u4e0a\u4f20\u7684\u56fe\u50cf|\u4e0a\u4f20\u56fe\u7247|\u53c2\u8003\u56fe)/i.test(prompt)
}

function classifyContent(category, title) {
  const joined = `${category} ${title}`.toLowerCase()
  if (/(app|ui|web|\u7f51\u9875|\u754c\u9762)/i.test(joined)) return 'ui'
  if (/(logo|\u6807\u5fd7|\u5fbd\u6807)/i.test(joined)) return 'logo'
  if (/(text|typography|infographic|diagram|poster|thumbnail|\u6587\u672c|\u6392\u7248|\u4fe1\u606f\u56fe|\u56fe\u8868|\u6d77\u62a5|\u7f29\u7565\u56fe)/i.test(joined)) return 'text'
  if (/(illustration|anime|comic|chibi|pixel|watercolor|painting|\u63d2\u753b|\u52a8\u6f2b|\u6f2b\u753b|\u6c34\u5f69|\u6cb9\u753b|\u50cf\u7d20)/i.test(joined)) return 'illustration'
  return 'photo'
}

function safeId(value) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'prompt'
}

const entryPattern = /^### No\. (\d+): (.+)\r?\n([\s\S]*?)(?=^---\r?\n\r?\n### No\.|(?![\s\S]))/gm
const records = []
for (const match of allPrompts.matchAll(entryPattern)) {
  const heading = match[2].trim()
  const body = match[3]
  const prompt = body.match(/```[^\r\n]*\r?\n([\s\S]*?)```/)?.[1]?.trim() || ''
  const sourceId = body.match(/gpt-image-2-prompts\?id=(\d+)/)?.[1] || match[1]
  if (prompt.length < 30) continue
  const separator = heading.indexOf(' - ')
  const category = separator >= 0 ? heading.slice(0, separator).trim() : 'uncategorized'
  const title = separator >= 0 ? heading.slice(separator + 3).trim() : heading
  records.push({
    sourceId,
    sourceUrl: `https://youmind.com/zh-CN/gpt-image-2-prompts?id=${sourceId}`,
    slug: `${sourceId}-${safeId(title)}`,
    title,
    prompt,
    categories: [category],
    requiresReference: needsReference(prompt),
  })
}

const uniqueRecords = [...new Map(records.map((record) => [record.sourceId, record])).values()]
const buckets = new Map()
for (const record of uniqueRecords.filter((candidate) => !candidate.requiresReference)) {
  const category = record.categories[0]
  if (!buckets.has(category)) buckets.set(category, [])
  buckets.get(category).push(record)
}

const selected = []
while (selected.length < requestedCount) {
  let added = false
  for (const bucket of buckets.values()) {
    const record = bucket.shift()
    if (!record) continue
    selected.push(record)
    added = true
    if (selected.length === requestedCount) break
  }
  if (!added) break
}
if (selected.length < requestedCount) {
  throw new Error(`only ${selected.length} standalone prompts are available from ${uniqueRecords.length} repository entries`)
}

const ratios = ['1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '21:9']
const routes = ['api', 'mcp', 'skill']
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
    contentClass: classifyContent(record.categories[0], record.title),
  })
}

const repositoryCommit = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const manifest = {
  version: 1,
  source: 'https://github.com/YouMind-OpenLab/awesome-gpt-image-2',
  repositoryCommit,
  collectedAt: new Date().toISOString(),
  requestedCount,
  parsedEntries: uniqueRecords.length,
  excludedReferenceDependent: uniqueRecords.filter((record) => record.requiresReference).length,
  tasks,
}
const manifestPath = resolve(inputRoot, 'youmind-prompts.json')
await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
console.log(JSON.stringify({
  output: manifestPath,
  repositoryCommit,
  parsed: uniqueRecords.length,
  selected: tasks.length,
  excludedReferenceDependent: manifest.excludedReferenceDependent,
  categories: Object.fromEntries([...new Set(tasks.map((task) => task.categories[0]))].map((category) => [category, tasks.filter((task) => task.categories[0] === category).length])),
  routes: Object.fromEntries(routes.map((route) => [route, tasks.filter((task) => task.route === route).length])),
  ratios: Object.fromEntries(ratios.map((ratio) => [ratio, tasks.filter((task) => task.ratio === ratio).length])),
}, null, 2))

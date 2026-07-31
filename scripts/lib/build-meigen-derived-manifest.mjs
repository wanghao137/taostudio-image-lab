import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { extractRequestedImageCount, extractStrictRatio, DIMENSIONS_BY_RATIO } from './full-batch-planning.mjs'

// 派生清单构造器：从不可变源清单生成本地可执行的 generation manifest。
// 严格第一性原则：
// - prompt 逐字节引用源清单，绝不改写；
// - promptSha256 复算并断言与源一致；
// - ratio 由 extractStrictRatio(prompt) 优先确定，否则按主归档媒体真实尺寸取最近支持比例；
// - 不得根据"横版/竖版/海报"等文字猜比例，无法确定才标记 blocked；
// - 归档媒体是历史生成结果(existing_output)，不自动构成输入参考图，referenceDependent 默认 false。

const SUPPORTED_RATIOS = Object.keys(DIMENSIONS_BY_RATIO)

// 就近匹配原图宽高比到一个支持比例。返回 { ratio, error } 便于调用方应用容差。
// 与旧版相比不再"无阈值强行归一"——调用方决定误差可否接受。
export function bestRatioForSize(width, height) {
  if (!width || !height) return { ratio: null, error: Number.POSITIVE_INFINITY }
  const target = width / height
  let best = null
  let bestDiff = Number.POSITIVE_INFINITY
  for (const ratio of SUPPORTED_RATIOS) {
    const [rw, rh] = ratio.split(':').map(Number)
    const diff = Math.abs(rw / rh - target)
    if (diff < bestDiff) {
      bestDiff = diff
      best = ratio
    }
  }
  return { ratio: best, error: best ? bestDiff / target : Number.POSITIVE_INFINITY }
}

// 原图宽高比与某个支持比例的最大允许相对误差。超过则不强行归一，标记 blocked。
// 8% 容差覆盖了 4:5(0.8)->3:4(0.75, 差6.25%) 这类"近似但不同"的情况——
// 既然 prompt 没明确写比例，宁可让人工确认，也不要生成被裁切的错误比例图。
const NEAREST_RATIO_TOLERANCE = 0.08

// ratio 判定的唯一入口：prompt 明确比例优先（忠于作者意图），其次原图就近匹配（加容差）。
export function resolveEntryRatio(prompt, primaryAsset) {
  const fromPrompt = extractStrictRatio(prompt)
  if (fromPrompt) return { ratio: fromPrompt, source: 'prompt' }
  if (primaryAsset && primaryAsset.width && primaryAsset.height) {
    const nearest = bestRatioForSize(primaryAsset.width, primaryAsset.height)
    if (nearest.ratio && nearest.error <= NEAREST_RATIO_TOLERANCE) {
      return { ratio: nearest.ratio, source: 'nearest_source_aspect' }
    }
    return { ratio: null, source: 'aspect_too_far' }
  }
  return { ratio: null, source: 'undeterminable' }
}

// 文字/标识/海报类：排版、标题、字体、卡片、广告、杂志、书籍、报纸、菜单、Logo、品牌、横幅
const TEXT_KEYWORDS =
  /海报|封面|横幅|banner|杂志|报纸|书籍|菜单|卡片|名片|传单|广告|标签|标题|排版|字体|字效|文字|文章|教程|说明书|目录|日历|证书|邀请函|节目单|歌词|诗|章节|绘本内文|logo|标识|徽标|商标|品牌名|店招|片头|片尾|字幕|弹幕|图文|微博图|朋友圈文案|九宫格|长图排版|条漫|分镜|连环画|漫画格子|表格|数据图|信息图|图表|流程图|思维导图|时间轴|时间线|年表|清单图|盘点|榜单|排行榜|封面图|头图|题图|缩略图|教程图|步骤图|说明书图|产品参数|规格表|价目表|报价单|优惠券|折扣|促销|满减|活动|倒计时|预告|节目预告|播出表|课程表|作息表|行程表|日程|计划表|打卡表|签到表|成绩单|奖状/i

// 插画/矢量/卡通类
const ILLUSTRATION_KEYWORDS =
  /插画|手绘|卡通|动漫|二次元|q版|q版|线稿|矢量|扁平化|赛璐璐|水彩|彩铅|素描|涂鸦|简笔画|漫画|illustration|cartoon|anime|manga|vector|flat|sketch|drawing|line art/i

// Logo/标识类（更窄）
const LOGO_KEYWORDS = /^.{0,60}(logo|徽标|商标|标识|品牌标志|店招|台标)/i

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function classifyContentClass(prompt) {
  const text = String(prompt || '')
  if (LOGO_KEYWORDS.test(text)) return 'logo'
  if (TEXT_KEYWORDS.test(text)) return 'text'
  if (ILLUSTRATION_KEYWORDS.test(text)) return 'illustration'
  return 'photo'
}

function isPathSafeSegment(folderName) {
  const value = String(folderName || '')
  if (!value) return false
  if (/[\\/:]/.test(value)) return false
  if (value === '.' || value === '..') return false
  return true
}

// 把一个多图 prompt 拆成每个 outputIndex 聚焦的单场景片段。
// 只处理结构明确的情况（数字编号 / Image N 分块）；无法可靠拆分时返回 null，
// 调用方退回到"完整 prompt + 单图约束"策略（仍能避免 provider 多生成，只是不按场景聚焦）。
export function extractSceneSegments(prompt, outputCount) {
  const text = String(prompt || '')
  if (outputCount <= 1) return null
  // 模式 A: "1. Title\n描述\n2. Title\n描述..."（数字编号 + 换行）
  const numberedSplit = text.split(/\n(?=\d+\.\s)/)
  if (numberedSplit.length >= outputCount) {
    const intro = numberedSplit[0]
    const scenes = numberedSplit.slice(1, outputCount + 1)
    if (scenes.length === outputCount && scenes.every((s) => s.trim())) {
      return { intro, scenes }
    }
  }
  // 模式 B: "Image 1\n...\nImage 2\n..."（Image N 换行分块）
  const imageSplit = text.split(/\n(?=Image\s*\d\b)/i)
  if (imageSplit.length >= outputCount) {
    const intro = imageSplit[0]
    const scenes = imageSplit.slice(1, outputCount + 1)
    if (scenes.length === outputCount && scenes.every((s) => s.trim())) {
      return { intro, scenes }
    }
  }
  return null
}

// 为多图 item 构造单场景执行 prompt：聚焦指定场景 + 强制单图约束。
// 提示词.txt 仍保存完整原 prompt；这里只构造发给 provider 的执行 prompt。
export function buildSceneExecutionPrompt(prompt, outputCount, outputIndex) {
  const text = String(prompt || '')
  const segments = extractSceneSegments(text, outputCount)
  const singleConstraint = [
    `Generate ONLY ONE single image. This is image ${outputIndex} of ${outputCount} in the series.`,
    'Do not generate multiple images or a grid/collage.',
  ].join(' ')
  if (segments) {
    const scene = segments.scenes[outputIndex - 1] || segments.scenes[0]
    return `${singleConstraint}\n\nShared visual language and context:\n${segments.intro.trim()}\n\nGenerate only this specific scene:\n${scene.trim()}`
  }
  // 无法按场景拆分时：完整 prompt + 单图约束（避免 provider 多生成，虽不按场景聚焦）
  return `${singleConstraint}\n\n${text}`
}

export async function buildDerivedManifest({ sourcePath, outputPath, strict = true }) {
  const source = JSON.parse(await readFile(sourcePath, 'utf8'))
  const entries = Array.isArray(source) ? source : (source.entries || [])

  const derived = {
    schemaVersion: 'meigen-derived-1',
    sourceType: 'derived-generation-manifest',
    sourceManifest: sourcePath,
    generatedAt: new Date().toISOString(),
    routes: {
      primary: { model: 'gpt-image-2', apiMode: 'images' },
      revision: { model: 'gpt-5.6-sol', apiMode: 'responses' },
    },
    supportedDimensions: DIMENSIONS_BY_RATIO,
    entries: [],
    blocked: [],
  }

  const stats = {
    total: entries.length,
    ratioFromPrompt: 0,
    ratioFromSize: 0,
    blocked: 0,
    contentClass: { text: 0, logo: 0, illustration: 0, photo: 0 },
    multiImage: 0,
    expandedJobs: 0,
    promptShaMismatch: 0,
  }

  for (const entry of entries) {
    const prompt = String(entry.prompt || '')
    const label = `entry ${entry.index}`

    // 1. promptSha256 复算断言
    const recalculated = sha256(prompt)
    if (entry.promptSha256 && recalculated !== entry.promptSha256) {
      stats.promptShaMismatch += 1
      if (strict) throw new Error(`${label} promptSha256 does not match recomputed digest`)
    }

    // 2. 文件夹名路径安全断言
    if (!isPathSafeSegment(entry.folderName)) {
      throw new Error(`${label} folderName is not a safe path segment: ${entry.folderName}`)
    }

    // 3. ratio 判定：prompt 明确比例优先（忠于作者意图），其次原图就近匹配（8% 容差）。
    //    不再无阈值强行归一——原图比例离任何支持比例都太远时标记 blocked，避免错误比例生图。
    const primaryAsset = (entry.assets || []).find((asset) => asset.width && asset.height) || null
    const resolved = resolveEntryRatio(prompt, primaryAsset)
    const ratio = resolved.ratio
    const ratioSource = resolved.source
    if (!ratio) {
      stats.blocked += 1
      derived.blocked.push({
        index: entry.index,
        meigenId: entry.meigenId,
        reason: ratioSource === 'aspect_too_far' ? 'ratio_aspect_too_far' : 'ratio_undeterminable',
        promptSha256: recalculated,
      })
      continue
    }

    const dimensions = DIMENSIONS_BY_RATIO[ratio]
    const outputCount = extractRequestedImageCount(prompt)
    if (outputCount > 1) stats.multiImage += 1
    stats.expandedJobs += outputCount
    if (ratioSource === 'prompt') stats.ratioFromPrompt += 1
    else stats.ratioFromSize += 1

    const contentClass = classifyContentClass(prompt)
    stats.contentClass[contentClass] += 1

    // 多图条目：为每个 outputIndex 预计算聚焦单场景的执行 prompt（避免 provider 多生成）。
    // 提示词.txt 仍保存完整原 prompt；这些 executionScenes 只用于发给 provider。
    let executionScenes = null
    if (outputCount > 1) {
      executionScenes = Array.from({ length: outputCount }, (_, i) =>
        buildSceneExecutionPrompt(prompt, outputCount, i + 1),
      )
    }

    // 4. 归档媒体证据（只保留可复算事实，不改原始来源）
    const archiveEvidence = (entry.assets || []).map((asset) => ({
      ordinal: asset.ordinal,
      file: asset.file,
      origin: asset.origin,
      originDetail: asset.originDetail,
      format: asset.format,
      width: asset.width,
      height: asset.height,
      bytes: asset.bytes,
      sha256: asset.sha256,
      sourceUrl: asset.sourceUrl,
    }))

    derived.entries.push({
      index: entry.index,
      meigenId: entry.meigenId,
      folderName: entry.folderName,
      sourceIndex: entry.index,
      sourceMeigenId: entry.meigenId,
      sourceUrl: entry.sourceUrl,
      promptSource: entry.promptSource,
      prompt,
      promptSha256: recalculated,
      promptStatus: 'exact_prompt_recovered',
      duplicateOf: entry.duplicateOf || null,
      archiveMediaCount: entry.mediaCount,
      archiveEvidence,
      generation: {
        status: 'ready',
        ratio,
        ratioSource,
        dimensions,
        contentClass,
        referenceDependent: false,
        outputCount,
        ...(executionScenes ? { executionScenes } : {}),
      },
    })
  }

  derived.totals = stats
  await writeFile(resolve(outputPath), `${JSON.stringify(derived, null, 2)}\n`, 'utf8')
  return { derived, stats }
}

// 直接运行入口
const sourcePath = process.env.MEIGEN_SOURCE_MANIFEST
const outputPath = process.env.MEIGEN_DERIVED_MANIFEST
if (process.argv[1] && sourcePath && outputPath) {
  buildDerivedManifest({ sourcePath, outputPath })
    .then(({ stats }) => {
      console.log(`DERIVED_MANIFEST_OK entries=${stats.total} expanded=${stats.expandedJobs}`)
      console.log(`STATS ${JSON.stringify(stats)}`)
    })
    .catch((error) => {
      console.error(`DERIVED_MANIFEST_FAILED ${error.message}`)
      process.exit(1)
    })
}

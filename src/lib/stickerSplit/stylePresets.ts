// 贴纸风格预设：完整移植自 da-motion-sticker-skill 的 style-presets（36 种，MIT），
// 用于生成入口 —— 一键组装「风格 + 九宫格拼图 + 透明底」的完整提示词。
// 英文提示片段逐条来自上游 assets/style-presets.json，分组为本地导航组织。

export interface StickerStylePreset {
  id: string
  label: string
  /** 分组 id（见 STYLE_GROUPS，仅用于 UI 导航） */
  group: string
  /** 风格描述（英文提示词片段，与上游预设逐字一致） */
  stylePrompt: string
}

export interface StickerStyleGroup {
  id: string
  label: string
}

export const STYLE_GROUPS: StickerStyleGroup[] = [
  { id: 'q-toy', label: 'Q版潮玩' },
  { id: 'comic-manga', label: '漫画动漫' },
  { id: 'handdrawn', label: '手绘涂鸦' },
  { id: 'chinese-trad', label: '中式与手作' },
  { id: 'paper-collage', label: '纸艺拼贴' },
  { id: 'pixel-ui', label: '像素与复古 UI' },
  { id: 'print', label: '印刷与网络' },
  { id: 'classic-art', label: '名画戏仿' },
  { id: 'real-emoji', label: '真人与 Emoji' },
]

export const STICKER_STYLE_PRESETS: StickerStylePreset[] = [
  // —— Q版潮玩
  { id: 'big-head-chibi', label: 'Q版大头', group: 'q-toy', stylePrompt: 'clean big-head chibi character design, head 50–65 percent of total height, tiny torso, extremely short arms and feet, cute facial construction while preserving identity' },
  { id: 'soft-clay-3d', label: '3D 软陶', group: 'q-toy', stylePrompt: 'hand-sculpted soft-clay 3D character, rounded volumes, subtle fingerprint texture, oversized head and tiny body, playful tactile expression' },
  { id: 'plush-doll-3d', label: '3D 毛绒玩偶', group: 'q-toy', stylePrompt: 'collectible plush-doll character, short dense fibers across hair and clothes, soft stuffed volumes, oversized head, compact toy proportions' },
  { id: 'vinyl-toy', label: '搪胶公仔', group: 'q-toy', stylePrompt: 'designer vinyl toy and blind-box figure aesthetic, smooth molded surfaces, simplified premium color blocking, bold collectible proportions' },
  { id: 'clay-stop-motion', label: '黏土定格', group: 'q-toy', stylePrompt: 'rough handmade clay stop-motion aesthetic, visible sculpting marks, slightly clumsy pose language, charming frame-by-frame imperfection' },
  { id: 'semi-realistic-3d-big-head', label: '半写实 3D 大头', group: 'q-toy', stylePrompt: 'semi-realistic 3D big-head character, recognizable facial features and skin detail, highly chibi body proportions, balanced premium rendering and sticker clarity' },
  // —— 漫画动漫
  { id: 'anime-reaction', label: '日漫夸张表情', group: 'comic-manga', stylePrompt: 'extreme anime reaction language, stress veins, waterfall tears, shock marks and compact speed accents, highly readable comedic facial distortion' },
  { id: 'american-cartoon-meme', label: '美式卡通 Meme', group: 'comic-manga', stylePrompt: 'American web-cartoon meme style, bold internal ink lines, flat color shapes, adult-animation timing, strong side-eye, deadpan and smug expressions' },
  { id: 'newspaper-comic', label: '报纸漫画', group: 'comic-manga', stylePrompt: 'newspaper comic illustration, expressive pen lines, restrained red yellow and blue accents, subtle aged-paper texture contained within the character art, dry workplace humor' },
  { id: 'retro-halftone-comic', label: '复古漫画网点', group: 'comic-manga', stylePrompt: 'retro pop-comic rendering, Ben-Day halftone dots, slight CMYK misregistration inside the artwork, forceful graphic reaction language' },
  { id: 'black-white-manga', label: '黑白漫画', group: 'comic-manga', stylePrompt: 'high-contrast black-and-white manga drawing, decisive ink shadows, sparse gray tones, dramatic silent disbelief and emotional collapse' },
  // —— 手绘涂鸦
  { id: 'hand-doodle', label: '手绘涂鸦', group: 'handdrawn', stylePrompt: 'loose hand-drawn doodle style, wobbly notebook lines, intentionally naive anatomy, spontaneous awkward humor' },
  { id: 'child-crayon', label: '儿童蜡笔', group: 'handdrawn', stylePrompt: 'childlike crayon drawing, chunky wax strokes, uneven coloring, radically simplified forms, funny contrast between innocent craft and adult reactions' },
  // —— 中式与手作
  { id: 'chinese-new-year-print', label: '传统年画', group: 'chinese-trad', stylePrompt: 'Chinese folk New Year woodblock-print character, saturated red green and yellow, bold auspicious forms, festive exaggerated actions' },
  { id: 'guochao-paper-cut', label: '国潮剪纸', group: 'chinese-trad', stylePrompt: 'modern Chinese red paper-cut aesthetic, extremely flat cut shapes, intricate internal negative spaces, contemporary Emoji gestures' },
  { id: 'ink-wash-meme', label: '水墨 Meme', group: 'chinese-trad', stylePrompt: 'Chinese ink-wash character with expressive brush economy, dry and wet ink variation contained within the figure, ample transparent negative space, understated modern humor' },
  { id: 'embroidered-patch', label: '刺绣贴章', group: 'chinese-trad', stylePrompt: 'embroidered textile character, visible thread direction and fabric weave, chunky stitched internal linework, patch-like material without any added outer sticker border' },
  { id: 'felt-applique', label: '毛毡布贴', group: 'chinese-trad', stylePrompt: 'hand-cut felt applique character, layered colored fabric pieces, soft fuzzy edges intrinsic to the material, warm handmade construction' },
  { id: 'layered-paper', label: '纸雕', group: 'chinese-trad', stylePrompt: 'refined layered-paper sculpture, stacked colored paper shapes, shallow dimensional layering contained within the isolated figure, precise craft detail' },
  // —— 纸艺拼贴
  { id: 'lofi-paper-meme', label: '低保真剪纸 Meme', group: 'paper-collage', stylePrompt: 'lo-fi cut-paper internet meme aesthetic, coarse paper grain, awkward handmade cutout shapes, deliberately absurd poses, raw collage energy, exaggerated reaction faces' },
  { id: 'torn-paper-collage', label: '撕纸拼贴', group: 'paper-collage', stylePrompt: 'wild torn-paper collage, ripped magazine and newsprint fragments, rough irregular material edges, dirty energetic absurdity' },
  // —— 像素与复古 UI
  { id: 'pixel-art', label: '像素 Pixel Art', group: 'pixel-ui', stylePrompt: 'crisp 16-bit pixel-art character, readable game-sprite silhouette, limited palette, reaction poses staged like game abilities and power-ups' },
  { id: 'retro-arcade', label: '复古街机', group: 'pixel-ui', stylePrompt: 'rich 1990s arcade-game sprite aesthetic, dramatic fighting-game poses, compact HP, combo, or level-up motifs kept inside each character cell' },
  { id: 'windows-95-ui', label: 'Windows 95 UI', group: 'pixel-ui', stylePrompt: 'Windows 95 pixel UI aesthetic, compact error-dialog, progress-bar and button motifs held within each character\'s cell, retro desktop-assistant humor' },
  { id: 'classic-mac-ui', label: 'Mac OS 复古图标', group: 'pixel-ui', stylePrompt: 'classic monochrome Macintosh pixel-icon language, compact dialog, hourglass and bomb-icon motifs kept local to the character, vintage desktop assistant charm' },
  // —— 印刷与网络
  { id: 'riso-print', label: 'Riso 孔版印刷', group: 'print', stylePrompt: 'two-to-four-color risograph print, grainy ink, slight internal color misregistration, youthful independent-design energy' },
  { id: 'screen-print', label: '丝网印刷', group: 'print', stylePrompt: 'high-contrast screen-print graphic, restricted colors, coarse ink grain, bold music-merchandise attitude' },
  { id: 'y2k-web-meme', label: 'Y2K 网络表情', group: 'print', stylePrompt: 'Y2K internet meme aesthetic, holographic color accents, deliberately low-resolution PNG flavor, compact glitter and star motifs, exuberant LOL and OMG energy' },
  { id: 'vhs-screenshot', label: 'VHS 低清截图', group: 'print', stylePrompt: 'VHS reaction-screenshot aesthetic, analog color drift, scanline texture and tape grain restricted to the isolated figure, strong caught-in-motion pose' },
  // —— 名画戏仿
  { id: 'oil-painting-parody', label: '油画恶搞', group: 'classic-art', stylePrompt: 'classical oil-portrait rendering applied to modern meme actions, visible brushwork and dignified lighting contained on the isolated character, comic historical contrast' },
  { id: 'renaissance-meme', label: '文艺复兴 Meme', group: 'classic-art', stylePrompt: 'Renaissance-inspired figure painting, classical gesture and restrained sacred-light modeling contained on the character, humorously modern reaction themes' },
  { id: 'ukiyo-e-meme', label: '浮世绘 Meme', group: 'classic-art', stylePrompt: 'ukiyo-e woodblock character, carved contour rhythm, flat traditional colors, compact wave and cloud motifs that remain inside each cell, modern meme action' },
  // —— 真人与 Emoji
  { id: 'emoji-3d-hybrid', label: 'Emoji 3D 混合', group: 'real-emoji', stylePrompt: 'recognizable character face combined with glossy three-dimensional Emoji body language and compact Emoji-like accents, immediate chat readability' },
  { id: 'personified-emoji', label: '表情符号拟人', group: 'real-emoji', stylePrompt: 'personified Emoji reaction design, strongly enlarged brows, tears, hands or mouth shapes matching each Emoji while preserving the character\'s identity' },
  { id: 'reaction-gif-frame', label: 'Reaction GIF 截帧', group: 'real-emoji', stylePrompt: 'single-frame reaction-GIF aesthetic, dynamic off-balance poses, restrained internal motion smear and deliberate timing offset, instantly readable action setup' },
  { id: 'photo-head-cartoon-body', label: '真人头卡通身', group: 'real-emoji', stylePrompt: 'high-recognition photographic face on an extremely small stylized cartoon body, intentionally exaggerated scale contrast, tiny limbs and meme-ready poses' },
]

/** 空状态等紧凑场景展示的常用子集（完整 36 种见拼图风格弹层） */
export const COMMON_STICKER_STYLE_IDS = [
  'big-head-chibi',
  'soft-clay-3d',
  'vinyl-toy',
  'anime-reaction',
  'pixel-art',
  'chinese-new-year-print',
  'ink-wash-meme',
  'semi-realistic-3d-big-head',
]

export function getStickerStyle(id: string): StickerStylePreset | undefined {
  return STICKER_STYLE_PRESETS.find((s) => s.id === id)
}

/**
 * 组装九宫格贴纸拼图生成提示词：
 * 风格 + 3×3 同角色多表情 + 每格完整独立 + 宽透明间隔 + 无文字。
 */
export function buildStickerSheetPrompt(styleId: string, subject?: string): string {
  const style = getStickerStyle(styleId)
  if (!style) throw new Error(`未知的贴纸风格：${styleId}`)
  const subjectLine = subject?.trim() ? `角色：${subject.trim()}。` : ''
  return [
    `生成一张 3×3 九宫格贴纸拼图（正方形画布）。${subjectLine}`,
    `同一个角色的 9 个不同表情与反应（例如：开心、大笑、生气、惊讶、哭泣、比心、疑惑、害羞、加油），每格一个完整独立的表情，角色姿态有变化但身份、画风、配色完全一致。`,
    `画风要求：${style.stylePrompt}。`,
    '每格之间留出较宽且完全透明的间隔，角色不出格、不互相重叠；整图为透明背景 PNG，无背景元素、无文字、无水印。',
  ].join('\n')
}

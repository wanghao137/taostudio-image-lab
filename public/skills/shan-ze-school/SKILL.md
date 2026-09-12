---
name: shan-ze-school
title: 山海经水墨幻想
description: Generate or refine prompts for 杉泽流派 / Shan Ze school-inspired new-oriental mythic ink-and-color fantasy images, especially when the user asks for 山海经、神怪、异兽、妖怪、国风神话、工笔水墨奇幻、东方幻想生物插画, or wants an existing prompt rewritten into this visual language. Use for original image-generation prompts, prompt rewrites, style transfer phrasing, and concise style analysis that translates any living-artist reference into broader art-historical visual grammar.
metadata:
  vsc-category: "东方幻想"
  vsc-deliverables: "prompt,image"
  vsc-distinction: "明确的东方神怪、山海经异兽、工笔水墨奇幻方向，支持提示词改写及可用工具下生图；广泛探索多种风格优先风格探索，不覆盖普通写实 COS。"
---

# 杉泽流派

> 本版为 TaoStudio Skill 工坊适配：原技能的参考文件已内联进本文，直接依据本文全部内容执行，无需读取外部文件或运行脚本。

## Core Rule

Translate requests for "Shan Ze / 杉泽 style" into an original art-historical visual grammar. Do not put a living artist's name in the final image prompt. Use precise descriptors: new-oriental mythic ink illustration, gongbi linework, xieyi ink atmosphere, shan-hai-jing bestiary, mineral pigments, silk-paper texture, smoke-cloud negative space.

If the user asks to generate an image, generate the image when an image tool is available. If direct image generation is not available, provide a ready-to-use prompt.

Default to prompt-writing rather than long art-history analysis. This skill is primarily for making prompts usable in image tools.

## Use This Skill When

- The user explicitly asks for 杉泽、Shan Ze、山海经异兽、东方神怪工笔奇幻一类的图像提示词。
- The user gives a rough creature idea and wants it rewritten into a mythic ink-and-color illustration prompt.
- The user provides an existing prompt and wants it "更像杉泽流派" but without naming a living artist directly.
- The user wants a short style breakdown in order to feed another image model or prompt workflow.

## Do Not Use This Skill When

- The main task is image criticism, art-history attribution, or academic classification without prompt generation.
- The subject is not mythic, spiritual, bestiary-like, or new-oriental fantasy in tone.
- The user wants contemporary graphic design, anime, photoreal concept art, or Western fantasy rendering.
- The user needs a broad Chinese illustration taxonomy rather than a narrow prompt language. In those cases, prefer `$中国插画`.

## Workflow

1. Identify the subject: mythic creature, deity, spirit, hybrid animal, scene, portrait, or artifact.
2. Choose a composition:
   - floating creature in blank paper space
   - horizontal handscroll pursuit scene
   - screen-painting tableau under flowering canopy
   - bestiary plate with seal and minimal inscription
3. Build the prompt with four layers:
   - **Structure**: gongbi baimiao contour, iron-wire line, hairline tendrils, anatomical hybridization.
   - **Color**: ink gray, cinnabar, rouge red, malachite green, azurite blue, ochre, pale shell white.
   - **Atmosphere**: ink-wash smoke, cloud-reserve negative space, mist diffusion, wet-on-dry paper bleeding.
   - **Finish**: silk or xuan-paper grain, translucent washes, no oil-paint impasto, no photoreal rendering.
4. Add negative constraints to prevent drift: no Western oil painting, no anime cel shading, no 3D render, no hard sci-fi armor, no glossy digital airbrush, no neon cyberpunk.
5. If the user supplied a draft prompt, preserve the core subject and only rewrite the style layer.
6. If the user asks for variants, change one axis at a time: composition, pigment emphasis, atmosphere, or creature anatomy.

## Output Modes

- **Direct image generation**: generate the image if an image tool is available.
- **Ready-to-use prompt**: default output for most requests.
- **Prompt rewrite**: keep the user's subject, simplify weak adjectives, and replace artist-name shorthand with material, brushwork, composition, and negative constraints.
- **Mini style note**: when asked "为什么这像杉泽流派", answer briefly and stay tied to promptable visual features.

## Prompt Template

Use this compact template unless the user asks for a different format:

```text
Original new-oriental mythic ink-and-color illustration of [SUBJECT], inspired by shan-hai-jing bestiary imagery and classical East Asian gongbi painting. [POSE/COMPOSITION]. Fine baimiao contour drawing, iron-wire linework, hairline ink tendrils, translucent mineral-pigment washes, ink-gray smoke-cloud negative space, cinnabar and rouge accents, malachite green and azurite blue details, ochre undertones, xuan-paper or silk texture, layered fenran and zhaoran dyeing, broken-ink mist, dry-brush flying-white edges, restrained decorative patterning, seal-script red chop mark, ethereal but anatomical hybrid creature design.

Negative prompt: photorealism, oil painting impasto, Western chiaroscuro, anime cel shading, 3D render, plastic gloss, cyberpunk neon, hard sci-fi armor, cute mascot proportions, flat vector art, excessive symmetry, cluttered background.
```

## Style Reference

For deeper vocabulary, use the inlined 「参考：风格语法（Style Grammar）」 section below, especially when the user asks for a very detailed prompt, variations, art direction, or style analysis.

## 参考：风格语法（Style Grammar）

# Style Grammar

## Art-Historical Base

- New-oriental mythic fantasy illustration
- Shan-hai-jing bestiary visual system
- Gongbi color painting: baimiao, iron-wire contour, fenran, zhaoran, pingtu, tuose
- Xieyi ink atmosphere: pomo, jimo, broken-ink diffusion, dry-brush flying white
- Dunhuang mural influence: ribbon movement, mineral pigments, floating celestial line rhythm
- Ming-Qing strange-tales imagery: fox spirits, hybrid beasts, ghostly attendants, ritual ornaments
- East Asian yokai painting as secondary reference: scroll-like movement, uncanny body distortion, creature taxonomy

## Line And Brushwork

- Baimiao contour drawing
- Tiexianmiao / iron-wire line
- Yousimiao / gossamer thread line
- Nail-head rat-tail modulation for claws, horns, and tendons
- Dry-brush fur strokes
- Broken contour at mist-contact edges
- Calligraphic ribbon line for sashes, whiskers, tails, and smoke
- Fine stippled mineral-pigment texture for scales and hide

## Color System

- Ink gray, lampblack, warm charcoal
- Cinnabar, vermilion, rouge, madder lake
- Malachite green, azurite blue, turquoise oxidation
- Ochre, burnt sienna, raw umber, tea stain
- Pale shell white, rice-paper white, silk ground
- Avoid saturated rainbow palettes. Prefer two chromatic poles plus ink: red/green, red/blue, or cyan/ochre.

## Light And Space

- Use diffuse paper light, not a single Western spotlight.
- Use liubai / reserved blank space as luminous atmosphere.
- Let smoke and cloud forms define depth instead of linear perspective.
- Use color temperature shifts for volume: cool ink shadows, warm ochre underforms, cinnabar accents.
- Keep the background sparse unless the user asks for a scene.

## Creature Design

- Hybridize real anatomy: tiger spine, deer horn, fox muzzle, crane feather, serpent tail, human-like eyes, hoof or claw asymmetry.
- Preserve believable joint logic even when the creature is supernatural.
- Add one ritual marker: red sash, bell, jade pendant, bronze mask, cloud collar, talisman strip, or embroidered saddle cloth.
- Use elongated movement paths: trailing smoke, ribbon, tail, mane, or cloud wake.

## Composition Patterns

- **Blank-field apparition**: creature suspended in white space with smoke orbit.
- **Handscroll chase**: long horizontal movement, ribbon crossing panels, mist bands.
- **Flower canopy elegy**: resting beast beneath red blossoms, pale blue ground wash.
- **Bestiary plate**: isolated creature, red seal, tiny inscription, museum-plate restraint.
- **Ritual encounter**: small human figure facing a large spirit, scale contrast, fog boundary.

## Prompt Add-Ons

Use these when appropriate:

- "seal-script red chop mark in one corner"
- "subtle silk fiber texture visible through translucent washes"
- "cloud-scroll pattern engraved into the ribbon"
- "ink bleeding at the fur edges"
- "mineral pigment granulation in malachite and azurite"
- "half-erased body dissolving into smoke"
- "asymmetrical horns and uncanny human-like gaze"

## Negative Constraints

Always include some of these when generating:

- no direct living-artist name
- no photorealism
- no anime cel shading
- no oil-paint impasto
- no 3D render
- no glossy plastic surface
- no cyberpunk neon
- no hard sci-fi armor
- no Western medieval dragon cliches
- no cute mascot proportions

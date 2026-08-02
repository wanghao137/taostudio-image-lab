import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { API_MODES, extractRequestedImageCount } from '../../packages/image-job-core/index.mjs'

const MAX_OUTPUT_COPIES = 10

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function outputText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text
  const values = []
  for (const item of payload?.output || []) {
    if (typeof item?.text === 'string') values.push(item.text)
    for (const part of item?.content || []) {
      if (typeof part?.text === 'string') values.push(part.text)
    }
  }
  return values.join('\n')
}

function parseJsonText(text) {
  const source = String(text || '')
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || source
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('response did not contain a JSON object')
  return JSON.parse(fenced.slice(start, end + 1))
}

function responseEndpoint(baseUrl) {
  const normalized = String(baseUrl || '').replace(/\/+$/, '')
  return `${normalized.endsWith('/v1') ? normalized : `${normalized}/v1`}/responses`
}

function automationError(message, options = {}) {
  return Object.assign(new Error(message), {
    code: options.code || 'BATCH_AUTOMATION_FAILED',
    httpStatus: options.httpStatus,
  })
}

function variantPrompt(prompt, outputIndex, outputCount) {
  if (outputCount === 1) return prompt
  return [
    prompt,
    '',
    `MULTI-OUTPUT BATCH INSTRUCTION: Generate only standalone output ${outputIndex} of ${outputCount}.`,
    'Return one complete image, not a contact sheet, grid, collage, or multiple images inside one canvas.',
    'Keep the original intent while making this output a distinct variation from the other batch outputs.',
  ].join('\n')
}

function expandedJobKey(item, outputIndex, outputCount) {
  return `batch-output-${hash(`${item.request.idempotencyKey}\0${item.itemKey}\0${outputIndex}\0${outputCount}`).slice(0, 48)}`
}

export function expandBatchRequest(request) {
  if (!request || typeof request !== 'object' || !Array.isArray(request.items)) return request
  const items = request.items.flatMap((item) => {
    if (!item || typeof item !== 'object') return [item]
    const explicitCopies = item.copies
    const inferredCopies = extractRequestedImageCount(item.request?.input?.prompt)
    const copies = Number.isInteger(explicitCopies) && explicitCopies >= 1 && explicitCopies <= MAX_OUTPUT_COPIES
      ? explicitCopies
      : explicitCopies === undefined
        ? inferredCopies
        : 1
    return Array.from({ length: copies }, (_, index) => {
      const outputIndex = index + 1
      if (copies === 1) {
        return {
          ...item,
          sourceItemKey: item.itemKey,
          outputIndex,
          outputCount: copies,
        }
      }
      return {
        ...item,
        itemKey: `${item.itemKey}:${outputIndex}`,
        sourceItemKey: item.itemKey,
        outputIndex,
        outputCount: copies,
        request: {
          ...item.request,
          idempotencyKey: expandedJobKey(item, outputIndex, copies),
          input: {
            ...item.request.input,
            prompt: variantPrompt(item.request.input.prompt, outputIndex, copies),
          },
        },
      }
    })
  })
  return { ...request, items }
}

export function validateBatchAutomation(value) {
  const errors = []
  if (value === undefined) return errors
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['automation must be an object']
  if (typeof value.enabled !== 'boolean') errors.push('automation.enabled must be a boolean')
  if (value.autoRevise !== undefined && typeof value.autoRevise !== 'boolean') {
    errors.push('automation.autoRevise must be a boolean when provided')
  }
  if (value.maxRevisions !== undefined && (!Number.isInteger(value.maxRevisions) || value.maxRevisions < 0 || value.maxRevisions > 3)) {
    errors.push('automation.maxRevisions must be an integer from 0 to 3')
  }
  if (value.enabled) {
    const route = value.revisionRoute
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      errors.push('automation.revisionRoute is required when automation is enabled')
    } else {
      if (typeof route.provider !== 'string' || !route.provider.trim()) errors.push('automation.revisionRoute.provider is required')
      if (typeof route.model !== 'string' || !route.model.trim()) errors.push('automation.revisionRoute.model is required')
      if (!API_MODES.includes(route.apiMode)) errors.push(`automation.revisionRoute.apiMode must be one of ${API_MODES.join(', ')}`)
      if (route.apiMode !== 'responses') errors.push('automation.revisionRoute.apiMode must be responses')
    }
  }
  return errors
}

export function classifyQaVerdict(qa) {
  if (qa?.blankOrBroken) return { failureClass: 'asset_invalid', recoveryAction: 'route_fallback' }
  if (qa?.edgeClipping) return { failureClass: 'edge_clipping', recoveryAction: 'recompose' }
  if (qa?.backgroundConflict) return { failureClass: 'background_conflict', recoveryAction: 'preserve_background' }
  return { failureClass: 'semantic_mismatch', recoveryAction: 'revise_with_qa' }
}

export function buildQaRevisionPrompt(originalPrompt, qa) {
  const instructions = [
    'QUALITY REVISION:',
    'Revise the previous result while preserving the original requested subject, style, background, aspect ratio, and visual intent.',
    'Do not add a frame, matte, border, mockup sheet, neutral surround, or presentation background unless explicitly requested.',
  ]
  if (qa?.edgeClipping) {
    instructions.push(
      'Fix clipped meaningful content by recomposing or scaling enough to keep it inside the canvas.',
      'Keep a requested full-bleed background full-bleed; do not shrink the artwork into a framed card.',
    )
  }
  if (qa?.backgroundConflict) instructions.push('Restore the requested background and remove any unrequested border or neutral surround.')
  if (qa?.missingCoreStructure) instructions.push('Restore the missing core structure without redesigning unrelated parts.')
  if (qa?.notes) instructions.push(`QA feedback: ${String(qa.notes).trim()}`)
  return `${instructions.join('\n')}\n\n${originalPrompt}`
}

export function createProviderBatchAutomationEvaluator(options = {}) {
  const providerConfig = options.providerConfig || {}
  const timeoutMs = options.timeoutMs ?? 180_000

  async function callResponses(route, content) {
    if (!providerConfig.baseUrl || !providerConfig.apiKey) {
      throw automationError('provider configuration is unavailable', { code: 'BATCH_AUTOMATION_PROVIDER_UNAVAILABLE' })
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(responseEndpoint(providerConfig.baseUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${providerConfig.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: route.model,
          input: [{ role: 'user', content }],
        }),
      })
      const text = await response.text()
      if (!response.ok) {
        throw automationError(`batch automation provider returned HTTP ${response.status}`, {
          code: 'BATCH_AUTOMATION_PROVIDER_ERROR',
          httpStatus: response.status,
        })
      }
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw automationError('batch automation provider returned malformed JSON')
      }
      return parseJsonText(outputText(payload))
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw automationError('batch automation provider timed out', { code: 'BATCH_AUTOMATION_TIMEOUT' })
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    async rewrite({ prompt, error, route }) {
      const payload = await callResponses(route, [{
        type: 'input_text',
        text: [
          'Rewrite the image prompt so it is compliant with image safety policy while preserving all benign visual intent.',
          'Remove or generalize only the unsafe part. Do not add new visual elements, framing, borders, or a different background.',
          'Return only JSON: {"prompt":"rewritten prompt","changes":"short explanation"}',
          `Original prompt: ${prompt}`,
          `Provider failure: ${error?.message || error?.providerCode || 'content policy rejection'}`,
        ].join('\n'),
      }])
      if (!String(payload.prompt || '').trim()) throw automationError('safe rewrite returned no prompt')
      return { prompt: String(payload.prompt).trim(), changes: String(payload.changes || '') }
    },

    async qa({ prompt, imageBuffer, route }) {
      const preview = await sharp(imageBuffer)
        .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer()
      const payload = await callResponses(route, [
        {
          type: 'input_text',
          text: [
            'You are a strict visual QA inspector for an automated image generation pipeline.',
            'Fail only for objective major defects: clipped meaningful content, missing core requested structure, a blank or broken image, or a result that clearly ignores the prompt.',
            'Also fail when an unrequested gray or neutral border, matte, frame, mockup sheet, or surrounding background changes a requested full-bleed composition.',
            'Minor AI text spelling errors are not a failure unless the main requested title is missing or unreadable.',
            'Return only JSON with this exact shape:',
            '{"pass":true,"edgeClipping":false,"backgroundConflict":false,"missingCoreStructure":false,"blankOrBroken":false,"notes":"short explanation"}',
            `Requested prompt: ${prompt}`,
          ].join('\n'),
        },
        {
          type: 'input_image',
          image_url: `data:image/jpeg;base64,${preview.toString('base64')}`,
        },
      ])
      return {
        pass: payload.pass === true,
        edgeClipping: payload.edgeClipping === true,
        backgroundConflict: payload.backgroundConflict === true,
        missingCoreStructure: payload.missingCoreStructure === true,
        blankOrBroken: payload.blankOrBroken === true,
        notes: String(payload.notes || ''),
        model: route.model,
      }
    },
  }
}

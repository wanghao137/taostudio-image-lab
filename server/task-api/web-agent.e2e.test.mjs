import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  executeImageTask,
  getImageAssetManifest,
  getImageTaskCapabilities,
  listImageJobs,
} from '../../src/lib/imageTaskApi.ts'
import { createTaskApi } from './service.mjs'

let instance

afterEach(async () => {
  if (!instance) return
  await instance.api.close()
  await rm(instance.stateDir, { recursive: true, force: true })
  instance = undefined
})

describe('web Agent Image Task API adapter', () => {
  it('executes one idempotent high-quality PNG task through the server contract', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'taostudio-web-agent-'))
    const api = await createTaskApi({ stateDir, token: 'web-agent-token', concurrency: 1 })
    const address = await api.listen(0)
    instance = { api, stateDir }
    const request = {
      contractVersion: '1',
      idempotencyKey: 'web-agent-adapter-e2e-001',
      input: { prompt: 'web Agent adapter test' },
      composition: { ratio: '9:16' },
      generation: { provider: 'mock', model: 'mock-v1', baseSize: '720x1280', apiMode: 'images' },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', dimensions: '2160x3840', enhancement: 'lanczos3', contentClass: 'photo' },
    }
    const config = { baseUrl: address.url, token: 'web-agent-token' }
    const createdStates = []
    const updatedStates = []
    const first = await executeImageTask(config, request, {
      timeoutMs: 30_000,
      onJobCreated: (job) => { createdStates.push(job.state) },
      onJobUpdate: (job) => { updatedStates.push(job.state) },
    })
    const replay = await executeImageTask(config, request, { timeoutMs: 30_000 })
    expect(replay.job.id).toBe(first.job.id)
    expect(first.job.state).toBe('succeeded')
    expect(first.job.request.generation.apiMode).toBe('images')
    expect(createdStates).toEqual(['queued'])
    expect(updatedStates.at(-1)).toBe('succeeded')
    const bytes = Buffer.from(await first.image.arrayBuffer())
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(await (await import('sharp')).default(bytes).metadata()).toMatchObject({ width: 2160, height: 3840, format: 'png' })

    const capabilities = await getImageTaskCapabilities(config)
    expect(capabilities.capabilities.apiModes).toEqual(['images', 'responses'])
    expect(capabilities.capabilities.output.implementedEnhancements).toEqual(['lanczos3'])

    const jobs = await listImageJobs(config, { limit: 10, state: 'succeeded' })
    expect(jobs.items).toHaveLength(1)
    expect(jobs.items[0].id).toBe(first.job.id)

    const manifest = await getImageAssetManifest(config, first.job.finalAssetId)
    expect(manifest).toMatchObject({
      kind: 'final',
      width: 2160,
      height: 3840,
      parentAssetId: first.job.sourceAssetId,
    })
  })
})

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  ImageBatchItemV1,
  ImageBatchV1,
  ImageJobListV1,
  ImageJobV1,
  ImageTaskCapabilitiesV1,
} from '../../lib/imageTaskApi'
import EngineWorkspace from '../EngineWorkspace'

const apiMocks = vi.hoisted(() => ({
  getImageTaskCapabilities: vi.fn(),
  listImageJobs: vi.fn(),
  listImageBatches: vi.fn(),
  getImageJob: vi.fn(),
  getImageBatch: vi.fn(),
  getImageBatchSummary: vi.fn(),
  listImageBatchItems: vi.fn(),
  listAllImageBatchItems: vi.fn(),
  listImageBatchEvents: vi.fn(),
  subscribeImageTaskEvents: vi.fn(),
  getImageAssetBlob: vi.fn(),
  readLocalImageTaskApiConfig: vi.fn(),
}))

vi.mock('../../lib/imageTaskApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/imageTaskApi')>()
  return { ...actual, ...apiMocks }
})

const job = {
  id: 'job-selection-test',
  contractVersion: '1',
  request: {
    contractVersion: '1',
    idempotencyKey: 'selection-test',
    input: { prompt: 'Selection test image' },
    composition: { ratio: '1:1' },
    generation: { provider: 'configured', model: 'gpt-image-2', apiMode: 'images' },
    output: {
      ratioMode: 'inherit',
      format: 'png',
      quality: 'high',
      dimensions: '2880x2880',
      enhancement: 'lanczos3',
      contentClass: 'photo',
    },
  },
  state: 'succeeded',
  attempts: 1,
  routeIndex: 0,
  routeAttempts: 1,
  maxAttempts: 3,
  actualRoute: { provider: 'configured', model: 'gpt-image-2', apiMode: 'images' },
  cancelRequested: false,
  sourceAssetId: null,
  finalAssetId: null,
  events: [],
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:01:00.000Z',
} satisfies ImageJobV1

const batchItem = {
  itemKey: '1',
  sourceItemKey: '1',
  position: 0,
  outputIndex: 1,
  outputCount: 1,
  revision: 0,
  automationState: 'done',
  generationStatus: 'succeeded',
  qaStatus: 'passed',
  acceptanceStatus: 'accepted',
  humanReviewStatus: 'approved',
  humanReview: null,
  review: null,
  job,
  jobHistory: [],
} satisfies ImageBatchItemV1

const batch = {
  id: 'batch-selection-test',
  name: 'Selection test batch',
  state: 'completed',
  controlState: 'running',
  automation: {
    enabled: true,
    maxRevisions: 1,
    revisionRoute: { provider: 'configured', model: 'gpt-5.6-sol', apiMode: 'responses' },
  },
  acceptanceState: 'accepted',
  stats: {
    total: 1,
    terminal: 1,
    active: 0,
    queued: 0,
    succeeded: 1,
    failed: 0,
    cancelled: 0,
    accepted: 1,
    needsReview: 0,
    rejected: 0,
    acceptancePending: 0,
    qaPassed: 1,
    qaFailed: 0,
    qaNeedsReview: 0,
    qaNotRun: 0,
    humanReviewPending: 0,
    humanReviewApproved: 1,
    humanReviewRejected: 0,
  },
  items: [batchItem],
  events: [],
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:01:00.000Z',
} satisfies ImageBatchV1

const capabilities = {
  service: 'taostudio-image-task-api',
  apiVersion: '1',
  contractVersion: '1',
  manifestVersion: '1',
  capabilities: {
    inputModes: ['prompt'],
    apiModes: ['images', 'responses'],
    ratios: ['1:1'],
    generation: { defaultProvider: 'configured', defaultModel: 'gpt-image-2' },
    output: {
      formats: ['png'],
      qualities: ['high'],
      acceptedEnhancements: ['lanczos3'],
      implementedEnhancements: ['lanczos3'],
      enhancementFallback: 'lanczos3',
      maxEdge: 4096,
      maxPixels: 16_777_216,
    },
    retry: { maxAttempts: 3 },
    upload: { mediaTypes: ['image/png'], maxBytes: 20_000_000 },
    jobs: {
      states: ['queued', 'validating', 'generating', 'source_ready', 'enhancing', 'finalizing', 'succeeded', 'failed', 'cancelled'],
      defaultListLimit: 30,
      maxListLimit: 100,
    },
    batches: {
      maxItems: 100,
      states: ['running', 'paused', 'completed'],
      qaStatuses: ['not_run', 'passed', 'failed', 'needs_review'],
      acceptanceStatuses: ['pending', 'accepted', 'needs_review', 'rejected'],
      humanReviewStatuses: ['not_ready', 'pending', 'approved', 'rejected', 'not_applicable'],
      automation: {
        supported: true,
        maxRevisions: 3,
        features: ['multi_output_expansion', 'safe_rewrite', 'visual_qa', 'human_review', 'optional_auto_revision'],
      },
    },
    events: { transport: 'polling' },
  },
} satisfies ImageTaskCapabilitiesV1

const jobList = {
  items: [job],
  nextCursor: null,
  stats: {
    total: 1,
    terminal: 1,
    active: 0,
    queued: 0,
    succeeded: 1,
    failed: 0,
    cancelled: 0,
    byState: {
      queued: 0,
      validating: 0,
      generating: 0,
      source_ready: 0,
      enhancing: 0,
      finalizing: 0,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
    },
    matching: 1,
  },
} satisfies ImageJobListV1

describe('EngineWorkspace inspector selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.readLocalImageTaskApiConfig.mockReturnValue({
      baseUrl: 'http://127.0.0.1:9789',
      token: 'test-token',
    })
    apiMocks.getImageTaskCapabilities.mockResolvedValue(capabilities)
    apiMocks.listImageJobs.mockResolvedValue(jobList)
    apiMocks.listImageBatches.mockResolvedValue({ items: [batch] })
    apiMocks.getImageJob.mockResolvedValue(job)
    apiMocks.getImageBatch.mockResolvedValue(batch)
    apiMocks.getImageBatchSummary.mockResolvedValue((({ items: _items, events: _events, ...summary }) => summary)(batch))
    apiMocks.listImageBatchItems.mockResolvedValue({ items: batch.items, nextCursor: null, total: batch.stats.total })
    apiMocks.listAllImageBatchItems.mockResolvedValue(batch.items)
    apiMocks.listImageBatchEvents.mockResolvedValue({ items: batch.events, nextCursor: null, total: batch.events.length })
    apiMocks.subscribeImageTaskEvents.mockImplementation((_config, options) => new Promise((_resolve, reject) => {
      options.onOpen?.()
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
  })

  afterEach(() => cleanup())

  // The historical batch groups (已结束但不完整 / 历史批次) are collapsed by
  // default; tests that need to interact with an archived batch must expand it
  // first by clicking its section header.
  async function expandArchivedBatches() {
    // The history section header is a button with aria-expanded=false.
    const header = await screen.findByRole('button', { name: /历史批次/ }, { timeout: 10_000 })
    if (header.getAttribute('aria-expanded') === 'false') fireEvent.click(header)
  }

  it('switches from batch detail to the selected job detail', async () => {
    render(<EngineWorkspace />)

    await expandArchivedBatches()
    fireEvent.click(await screen.findByRole('button', { name: /Selection test batch/ }, { timeout: 10_000 }))
    expect(await screen.findByText('批次详情')).toBeTruthy()

    // The batch task queue loads asynchronously; wait for the item row to appear.
    fireEvent.click(await screen.findByRole('button', { name: /Selection test image/ }, { timeout: 10_000 }))

    expect(await screen.findByText('任务详情')).toBeTruthy()
    expect(screen.queryByText('批次详情')).toBeNull()
  }, 20_000)

  it('ignores a stale batch detail response after a job is selected', async () => {
    let resolveBatch!: (value: ImageBatchV1) => void
    apiMocks.getImageBatchSummary.mockImplementationOnce(() => new Promise((resolve) => {
      resolveBatch = resolve
    }))
    render(<EngineWorkspace />)

    await expandArchivedBatches()
    fireEvent.click(await screen.findByRole('button', { name: /Selection test batch/ }, { timeout: 10_000 }))
    // Items load independently of the delayed summary, so the batch-item row
    // is clickable while the summary fetch is still pending.
    fireEvent.click(await screen.findByRole('button', { name: /Selection test image/ }, { timeout: 10_000 }))
    expect(await screen.findByText('任务详情')).toBeTruthy()

    resolveBatch((({ items: _items, events: _events, ...summary }) => summary)(batch) as ImageBatchV1)

    await waitFor(() => {
      expect(screen.queryByText('批次详情')).toBeNull()
      expect(screen.getByText('任务详情')).toBeTruthy()
    })
  })

  it('separates active, attention-required, and archived batches', async () => {
    const runningBatch = {
      ...batch,
      id: 'batch-running',
      name: 'Active batch',
      state: 'running',
      controlState: 'running',
      acceptanceState: 'pending',
      runner: { active: true, owner: 'runner-test', attempt: 1, heartbeatAt: batch.updatedAt, leaseExpiresAt: batch.updatedAt },
      stats: { ...batch.stats, terminal: 0, active: 1, queued: 0, succeeded: 0, accepted: 0, acceptancePending: 1, qaPassed: 0, qaNotRun: 1 },
    } satisfies ImageBatchV1
    const interruptedBatch = {
      ...batch,
      id: 'batch-interrupted',
      name: 'Interrupted batch',
      state: 'running',
      controlState: 'running',
      acceptanceState: 'pending',
      runner: { active: false, owner: 'expired-runner', attempt: 2, heartbeatAt: batch.updatedAt, leaseExpiresAt: batch.updatedAt },
      stats: { ...batch.stats, terminal: 0, active: 1, succeeded: 0, accepted: 0, acceptancePending: 1, qaPassed: 0, qaNotRun: 1 },
    } satisfies ImageBatchV1
    apiMocks.listImageBatches.mockResolvedValue({ items: [batch, interruptedBatch, runningBatch] })

    render(<EngineWorkspace />)

    const activeSection = await screen.findByLabelText('执行中')
    const attentionSection = screen.getByLabelText('待处理')
    // The history group is collapsed by default; expand it to assert its rows.
    const historyHeader = screen.getByRole('button', { name: /历史批次/ })
    fireEvent.click(historyHeader)
    const historySection = screen.getByLabelText('历史批次')
    expect(within(activeSection).getByText('Active batch')).toBeTruthy()
    expect(within(attentionSection).getByText('Interrupted batch')).toBeTruthy()
    expect(within(historySection).getByText('Selection test batch')).toBeTruthy()
  })

  it('keeps one polling lifecycle while job and batch snapshots refresh', async () => {
    const visibilityListenerSpy = vi.spyOn(document, 'addEventListener')
    try {
      render(<EngineWorkspace />)

      // The archived batch is collapsed; wait on the job row instead, which is
      // always rendered, to confirm the workspace mounted and polling started.
      await screen.findByRole('button', { name: /Selection test image/ }, { timeout: 10_000 })
      await waitFor(() => {
        expect(visibilityListenerSpy.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(1)
      })
    } finally {
      visibilityListenerSpy.mockRestore()
    }
  })

  it('preserves the next page cursor when an event refreshes the first page', async () => {
    const secondJob = {
      ...job,
      id: 'job-selection-second',
      request: {
        ...job.request,
        idempotencyKey: 'selection-test-second',
        input: { prompt: 'Second page image' },
      },
    } satisfies ImageJobV1
    const thirdJob = {
      ...job,
      id: 'job-selection-third',
      request: {
        ...job.request,
        idempotencyKey: 'selection-test-third',
        input: { prompt: 'Third page image' },
      },
    } satisfies ImageJobV1
    const stats = { ...jobList.stats, total: 3, terminal: 3, succeeded: 3, matching: 3, byState: { ...jobList.stats.byState, succeeded: 3 } }
    apiMocks.getImageTaskCapabilities.mockResolvedValue({
      ...capabilities,
      capabilities: { ...capabilities.capabilities, events: { transport: 'sse' } },
    })
    apiMocks.listImageJobs.mockImplementation((_config, options = {}) => {
      if (options.cursor === 'cursor-2') return Promise.resolve({ items: [thirdJob], nextCursor: null, stats })
      if (options.cursor === 'cursor-1') return Promise.resolve({ items: [secondJob], nextCursor: 'cursor-2', stats })
      return Promise.resolve({ items: [job], nextCursor: 'cursor-1', stats })
    })
    let announceChange: (() => void) | undefined
    apiMocks.subscribeImageTaskEvents.mockImplementation((_config, options) => new Promise((_resolve, reject) => {
      announceChange = options.onChange
      options.onOpen?.()
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))

    // The job queue uses an IntersectionObserver sentinel for infinite scroll.
    // jsdom does not provide IntersectionObserver, so install a minimal stub
    // whose intersect() method fires the callback as if the sentinel scrolled
    // into view. This lets the test drive the auto-load without a real layout.
    const observerCallbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = []
    class IntersectionObserverStub {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) { observerCallbacks.push(cb) }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
    const fireIntersect = () => {
      for (const cb of observerCallbacks) cb([{ isIntersecting: true }])
    }

    render(<EngineWorkspace />)
    // Wait for the first page to render, then trigger the sentinel to auto-load
    // the second page (cursor-1). fireIntersect is retried inside waitFor
    // because the observer ref's cursor is only populated after the first-page
    // state commit, which may lag the initial render by a tick.
    await screen.findByText('Selection test image', {}, { timeout: 10_000 })
    await waitFor(() => {
      fireIntersect()
      // Keep retrying until the load is observed via a cursor-1 API call.
      expect(apiMocks.listImageJobs.mock.calls.some(([, options]) => options?.cursor === 'cursor-1')).toBe(true)
    }, { timeout: 5000 })
    expect(await screen.findByText('Second page image')).toBeTruthy()

    // An SSE change event refreshes the first page (no cursor). The previously
    // loaded second page must be preserved — it should not reappear as a
    // duplicate, and the cursor must remain usable.
    announceChange?.()
    await waitFor(() => {
      expect(apiMocks.listImageJobs.mock.calls.filter(([, options]) => !options?.cursor)).toHaveLength(2)
    })

    // Trigger the sentinel again to load the third page (cursor-2).
    await waitFor(() => {
      fireIntersect()
      expect(apiMocks.listImageJobs.mock.calls.some(([, options]) => options?.cursor === 'cursor-2')).toBe(true)
    }, { timeout: 5000 })
    expect(await screen.findByText('Third page image')).toBeTruthy()
    expect(apiMocks.listImageJobs.mock.calls.some(([, options]) => options?.cursor === 'cursor-2')).toBe(true)
    vi.unstubAllGlobals()
  })
})

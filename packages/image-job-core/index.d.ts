export type ImageDimensions = { width: number; height: number }
export type ImageTier = '1K' | '2K' | '4K'
export type JobState = 'queued' | 'validating' | 'generating' | 'source_ready' | 'enhancing' | 'finalizing' | 'succeeded' | 'failed' | 'cancelled'
export const CONTRACT_VERSION: '1'
export const MANIFEST_VERSION: '1'
export const MAX_EDGE: number
export const MAX_PIXELS: number
export const COMMON_IMAGE_RATIOS: readonly string[]
export const COMMON_SIZE_PRESETS: Readonly<Record<ImageTier, Readonly<Record<string, string>>>>
export const JOB_STATES: readonly JobState[]
export const TERMINAL_JOB_STATES: readonly JobState[]
export const JOB_STATE_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>>
export function parseImageSize(value: string): ImageDimensions | null
export function parseRatio(value: string): ImageDimensions | null
export function greatestCommonDivisor(a: number, b: number): number
export function formatExactRatio(width: number, height: number): string | null
export function relativeRatioError(left: ImageDimensions, right: ImageDimensions): number
export function ratioMatches(left: ImageDimensions, right: ImageDimensions, tolerance?: number): boolean
export function ratioMatchesWithinOnePixel(left: ImageDimensions, right: ImageDimensions): boolean
export function computeResizePlan(source: ImageDimensions, target: ImageDimensions, mode?: 'cover' | 'contain'): { mode: 'cover' | 'contain'; sourceWidth: number; sourceHeight: number; targetWidth: number; targetHeight: number; scale: number; drawX: number; drawY: number; drawWidth: number; drawHeight: number; aspectMismatch: boolean }
export function calculateImageSize(tier: ImageTier, ratio: string): string | null
export function deriveInheritedTarget(source: ImageDimensions, options?: { maxEdge?: number; maxPixels?: number }): ImageDimensions & { ratio: string | null; ratioError: number }
export function resolveOutputTarget(request: { output?: { ratioMode?: string; dimensions?: string | ImageDimensions; limits?: { maxEdge?: number; maxPixels?: number } } }, source?: ImageDimensions): ImageDimensions
export function resolveEnhancementPolicy(contentClass: string, requested?: string): { requested: string; selected: string; generativeAllowed: boolean; fallback: string | null }
export function assertTransition(from: JobState, to: JobState): true
export function validateImageJobRequest(request: Record<string, unknown>): { valid: boolean; errors: string[] }
export function createAssetManifest(input: Record<string, unknown>): Readonly<Record<string, unknown>> & ImageDimensions
export function verifySourceFinalInvariant(source: Record<string, unknown> & ImageDimensions, final: Record<string, unknown> & ImageDimensions): { valid: boolean; errors: string[] }

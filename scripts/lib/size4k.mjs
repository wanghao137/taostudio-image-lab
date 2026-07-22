export {
  calculateImageSize,
  parseImageSize,
  parseRatio,
} from '../../packages/image-job-core/index.mjs'

export function parseArParam(prompt) {
  const match = prompt.match(/--ar\s+(\d+(?:\.\d+)?[:xX\u00d7]\d+(?:\.\d+)?)/i)
  return match ? match[1].replace(/[xX\u00d7]/, ':') : null
}

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createTaskApi } from './service.mjs'

async function readEnvFile(path) {
  const values = {}
  const content = await readFile(path, 'utf8').catch(() => '')
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!match || match[1].startsWith('#')) continue
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
  return values
}

const localEnv = await readEnvFile(resolve('.env.local'))
const value = (name, fallback = '') => process.env[name] || localEnv[name] || fallback
const api = await createTaskApi({
  stateDir: value('IMAGE_TASK_API_STATE_DIR', '.local-task-api'),
  token: value('IMAGE_TASK_API_TOKEN') || undefined,
  concurrency: Number(value('IMAGE_TASK_API_CONCURRENCY', '1')),
  providerTimeoutMs: Number(value('IMAGE_TASK_API_PROVIDER_TIMEOUT_MS', '300000')),
  providerRetryBaseMs: Number(value('IMAGE_TASK_API_PROVIDER_RETRY_BASE_MS', '15000')),
  providerConfig: {
    baseUrl: value('IMAGE_TASK_PROVIDER_BASE_URL') || value('IMAGE_API_BASE_URL'),
    apiKey: value('IMAGE_TASK_PROVIDER_API_KEY') || value('IMAGE_API_KEY'),
    model: value('IMAGE_TASK_PROVIDER_MODEL', 'gpt-image-2'),
  },
})
const address = await api.listen(Number(value('IMAGE_TASK_API_PORT', '9789')))
console.log(`TaoStudio Image Task API listening at ${address.url}`)
console.log('Bearer authentication configured')
if (api.recoveredJobs) console.log(`Recovered interrupted jobs: ${api.recoveredJobs}`)

const shutdown = async () => {
  await api.close()
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

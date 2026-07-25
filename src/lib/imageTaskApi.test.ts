// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearLocalImageTaskApiConfig,
  createImageTaskGeneration,
  readLocalImageTaskApiConfig,
  saveLocalImageTaskApiConfig,
} from './imageTaskApi'

describe('Image Task API session configuration', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('normalizes and restores connection data from the current tab session', () => {
    const saved = saveLocalImageTaskApiConfig({
      baseUrl: ' http://127.0.0.1:9789/// ',
      token: ' session-token ',
    })

    expect(saved).toEqual({
      baseUrl: 'http://127.0.0.1:9789',
      token: 'session-token',
    })
    expect(readLocalImageTaskApiConfig()).toEqual(saved)
  })

  it('clears the runtime connection without persisting it to localStorage', () => {
    saveLocalImageTaskApiConfig({
      baseUrl: 'http://127.0.0.1:9789',
      token: 'session-token',
    })

    expect(window.localStorage.length).toBe(0)
    clearLocalImageTaskApiConfig()
    expect(readLocalImageTaskApiConfig()).toBeNull()
  })

  it('rejects unsupported URL schemes', () => {
    expect(() => saveLocalImageTaskApiConfig({
      baseUrl: 'file:///tmp/task-api',
      token: 'session-token',
    })).toThrow('must use HTTP or HTTPS')
  })
})

describe('Image Task API generation defaults', () => {
  it('leaves baseSize unset so the engine applies its 2K default', () => {
    const generation = createImageTaskGeneration({
      provider: 'configured',
      model: 'gpt-image-2',
      apiMode: 'images',
    })

    expect(generation).toEqual({
      provider: 'configured',
      model: 'gpt-image-2',
      apiMode: 'images',
    })
    expect(generation).not.toHaveProperty('baseSize')
  })
})

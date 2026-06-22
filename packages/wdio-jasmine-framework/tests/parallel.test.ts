import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, test, expect, vi, beforeEach } from 'vitest'

import { setupParallelContexts } from '../src/parallel.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockBrowser(opts?: {
    contexts?: string[]
    store?: AsyncLocalStorage<string>
}) {
    const store = opts?.store || new AsyncLocalStorage<string>()
    const contexts = opts?.contexts || ['ctx-0', 'ctx-1', 'ctx-2', 'ctx-3']
    let idx = 0
    return {
        isBidi: true,
        __parallelContextStore: store,
        __bidiCommandsEnabled: true,
        browsingContextCreate: vi.fn().mockImplementation(async () => {
            const ctx = contexts[idx++] || `ctx-${idx}`
            return { context: ctx }
        }),
        browsingContextClose: vi.fn().mockResolvedValue(undefined),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setupParallelContexts', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    test('returns no-op cleanup when totalSpecs is 0', async () => {
        const browser = mockBrowser()
        const { cleanup } = await setupParallelContexts({
            browser: browser as unknown as WebdriverIO.Browser,
            reporter: {},
            totalSpecs: 0,
            maxParallelContexts: 4,
        })

        expect(browser.browsingContextCreate).not.toHaveBeenCalled()
        await cleanup()
    })

    test('pre-allocates up to maxParallelContexts contexts', async () => {
        const browser = mockBrowser()

        await setupParallelContexts({
            browser: browser as unknown as WebdriverIO.Browser,
            reporter: {},
            totalSpecs: 5,
            maxParallelContexts: 2,
        })

        expect(browser.browsingContextCreate).toHaveBeenCalledTimes(2)
    })

    test('caps context count at total spec count', async () => {
        const browser = mockBrowser()

        await setupParallelContexts({
            browser: browser as unknown as WebdriverIO.Browser,
            reporter: {},
            totalSpecs: 3,
            maxParallelContexts: 10,
        })

        expect(browser.browsingContextCreate).toHaveBeenCalledTimes(3)
    })

    test('cleanup closes all contexts', async () => {
        const browser = mockBrowser()
        const { cleanup } = await setupParallelContexts({
            browser: browser as unknown as WebdriverIO.Browser,
            reporter: {},
            totalSpecs: 4,
            maxParallelContexts: 4,
        })

        expect(browser.browsingContextClose).not.toHaveBeenCalled()
        await cleanup()
        expect(browser.browsingContextClose).toHaveBeenCalledTimes(4)
    })

    test('cleanup restores original reporter.specStarted', async () => {
        const origFn = vi.fn()
        const reporter = { specStarted: origFn }

        const { cleanup } = await setupParallelContexts({
            browser: mockBrowser() as unknown as WebdriverIO.Browser,
            reporter,
            totalSpecs: 2,
            maxParallelContexts: 2,
        })

        expect(reporter.specStarted).not.toBe(origFn)
        await cleanup()
        expect(reporter.specStarted).toBe(origFn)
    })

    test('throws when context store is missing', async () => {
        const browser = mockBrowser()
        delete (browser as Record<string, unknown>).__parallelContextStore

        await expect(
            setupParallelContexts({
                browser: browser as unknown as WebdriverIO.Browser,
                reporter: {},
                totalSpecs: 2,
                maxParallelContexts: 2,
            })
        ).rejects.toThrow('Parallel context store not found')
    })

    test('reporter specStarted switches AsyncLocalStorage each call', async () => {
        const store = new AsyncLocalStorage<string>()
        const browser = mockBrowser({ store, contexts: ['ctx-0', 'ctx-1'] })
        const reporter = { specStarted: vi.fn() }

        await setupParallelContexts({
            browser: browser as unknown as WebdriverIO.Browser,
            reporter,
            totalSpecs: 3,
            maxParallelContexts: 2,
        })

        // Simulate Jasmine calling specStarted for each spec
        ;(reporter.specStarted as Function)({ id: 't1' })
        expect(store.getStore()).toBe('ctx-0')

        ;(reporter.specStarted as Function)({ id: 't2' })
        expect(store.getStore()).toBe('ctx-1')

        // Third call cycles back to ctx-0
        ;(reporter.specStarted as Function)({ id: 't3' })
        expect(store.getStore()).toBe('ctx-0')
    })

    test('reporter specStarted delegates to original callback', async () => {
        const origFn = vi.fn()
        const reporter = { specStarted: origFn }

        await setupParallelContexts({
            browser: mockBrowser() as unknown as WebdriverIO.Browser,
            reporter,
            totalSpecs: 1,
            maxParallelContexts: 1,
        })

        const test = { id: 't1', description: 'test' }
        ;(reporter.specStarted as Function).call({ ctx: 'myctx' }, test)
        expect(origFn).toHaveBeenCalledWith(test)
    })

    test('returns at least 1 context even with 0 maxParallelContexts', async () => {
        const browser = mockBrowser()

        await setupParallelContexts({
            browser: browser as unknown as WebdriverIO.Browser,
            reporter: {},
            totalSpecs: 5,
            maxParallelContexts: 0,
        })

        expect(browser.browsingContextCreate).toHaveBeenCalledTimes(1)
    })
})

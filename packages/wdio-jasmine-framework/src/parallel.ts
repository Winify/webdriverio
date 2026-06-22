/**
 * Parallel (context-per-spec) execution for the Jasmine framework adapter.
 *
 * When `jasmineOpts.parallelMode: 'contexts'` is set, this module adds
 * per-spec BiDi browsing context isolation. Each spec gets its own tab,
 * and an AsyncLocalStorage scope ensures all WebDriver commands inside
 * the spec target its assigned context.
 *
 * The context is switched via the Jasmine reporter's specStarted callback,
 * which fires synchronously before each spec begins executing.
 *
 * @module parallel
 */

import type { AsyncLocalStorage } from 'node:async_hooks'

import logger from '@wdio/logger'

import type { ParallelBrowser } from './types.js'

const log = logger('@wdio/jasmine-framework:parallel')

// ============================================================
// Context pre-allocation
// ============================================================

async function preallocateContexts(
    browser: WebdriverIO.Browser,
    count: number
): Promise<string[]> {
    const bidi = browser as unknown as { browsingContextCreate(params: { type: string }): Promise<{ context: string }> }
    const contexts = await Promise.all(
        Array.from({ length: count }, () =>
            bidi.browsingContextCreate({ type: 'tab' })
        )
    )
    return contexts.map((c: { context: string }) => c.context)
}

// ============================================================
// Main entry point
// ============================================================

export async function setupParallelContexts(params: {
    browser: WebdriverIO.Browser
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reporter: any
    totalSpecs: number
    maxParallelContexts: number
}): Promise<{ cleanup: () => Promise<void> }> {
    const { browser, reporter, totalSpecs, maxParallelContexts } = params

    if (totalSpecs === 0) {
        log.info('No specs found for parallel execution.')
        return { cleanup: async () => {} }
    }

    const batchSize = Math.min(
        Math.max(1, maxParallelContexts || 1),
        totalSpecs
    )

    log.info(
        `[Parallel] Collected ${totalSpecs} specs. ` +
        `Pre-allocating ${batchSize} contexts...`
    )

    const allocStart = Date.now()
    const contexts = await preallocateContexts(browser, batchSize)
    log.info(`[Parallel] ${contexts.length} contexts created in ${Date.now() - allocStart}ms`)

    const bidi = browser as ParallelBrowser
    const parallelStore = bidi.__parallelContextStore as AsyncLocalStorage<string>
    if (!parallelStore) {
        throw new Error('Parallel context store not found on browser instance.')
    }

    // Hook into the reporter's specStarted callback to switch contexts
    // before each spec begins executing.
    let specIndex = 0
    const origSpecStarted = reporter.specStarted
    reporter.specStarted = function (this: unknown, test: Record<string, unknown>) {
        const ctxIdx = specIndex++
        const contextId = contexts[ctxIdx % contexts.length]
        if (contextId) {
            parallelStore.enterWith(contextId)
        }
        if (typeof origSpecStarted === 'function') {
            return (origSpecStarted as Function).call(this, test)
        }
    }

    // Return cleanup function
    return {
        cleanup: async () => {
            // Restore original callback
            reporter.specStarted = origSpecStarted
            const bidiClose = browser as unknown as { browsingContextClose(params: { context: string }): Promise<unknown> }
            for (const ctx of contexts) {
                await bidiClose.browsingContextClose({ context: ctx })
                    .catch((err) => {
                        log.debug(`Cleanup error closing context ${ctx}: ${(err as Error).message}`)
                    })
            }
        },
    }
}

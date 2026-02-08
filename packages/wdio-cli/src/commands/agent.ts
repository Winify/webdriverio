/// <reference types="@wdio/globals/types" />
import readline from 'node:readline'
import pickBy from 'lodash.pickby'
import { remote } from 'webdriverio'
import chalk from 'chalk'
import type { Argv, Options } from 'yargs'

import { cmdArgs as runCmdArgs } from './run.js'
import { cmdArgs as replCmdArgs } from './repl.js'
import { getCapabilities } from '../utils.js'
import { CLI_EPILOGUE } from '../constants.js'
import type { AgentCommandArguments } from '../types.js'

const IGNORED_ARGS = [
    'bail', 'framework', 'reporters', 'suite', 'spec', 'exclude',
    'mochaOpts', 'jasmineOpts', 'cucumberOpts'
]

const AGENT_SPECIFIC_ARGS = new Set([
    'provider', 'model', 'token', 'providerUrl',
    'maxSteps', 'maxActions', 'timeout', 'toonFormat', 'contextWindow',
])

export const command = 'agent <option> [capabilities]'
export const desc = 'Run natural language browser automation via LLM agent'
export const cmdArgs: { [k in keyof AgentCommandArguments]?: Options } = {
    ...replCmdArgs,
    provider: {
        desc: 'LLM provider (ollama, anthropic, openai)',
        type: 'string',
        default: 'ollama',
    },
    model: {
        alias: 'm',
        desc: 'LLM model name (defaults depend on provider)',
        type: 'string',
    },
    token: {
        desc: 'API key for the LLM provider',
        type: 'string',
    },
    providerUrl: {
        desc: 'API endpoint URL for the LLM provider',
        type: 'string',
    },
    maxSteps: {
        desc: 'Max agentic loop steps (1 = single-pass)',
        type: 'number',
        default: 1,
    },
    maxActions: {
        desc: 'Max actions per LLM response',
        type: 'number',
        default: 3,
    },
    timeout: {
        desc: 'LLM request timeout in ms',
        type: 'number',
        default: 30000,
    },
    toonFormat: {
        desc: 'Element encoding format (yaml-like or tabular)',
        type: 'string',
        default: 'yaml-like',
    },
    contextWindow: {
        desc: 'Sliding window size for agentic memory',
        type: 'number',
        default: 3,
    },
} as const

export function builder (yargs: Argv) {
    return yargs
        .options(pickBy({ ...cmdArgs, ...runCmdArgs }, (_, key) => !IGNORED_ARGS.includes(key)))
        .example('$0 agent chrome', 'Run agent with local Ollama (default)')
        .example('$0 agent chrome --provider anthropic --token $ANTHROPIC_API_KEY', 'Run agent with Anthropic Claude')
        .example('$0 agent firefox --provider openai --model gpt-4o', 'Run agent with OpenAI')
        .example('$0 agent android --provider anthropic', 'Run agent on Android device via Appium')
        .example('$0 agent ./app.apk --provider anthropic', 'Run agent on Android app via Appium')
        .example('$0 agent ./app.app --provider anthropic', 'Run agent on iOS simulator app')
        .example('$0 agent chrome --provider anthropic --maxSteps 1', 'Run agent in single-pass mode')
        .epilogue(CLI_EPILOGUE)
        .help() as unknown
}

interface ActionResult {
    action: { type: string; target: string; value?: string }
    success: boolean
    error?: string
}

interface AgentResult {
    actions: { type: string; target: string; value?: string }[]
    steps: { step: number; actions: ActionResult[]; done: boolean }[]
    goalAchieved: boolean
    totalSteps: number
}

function errorMessage (err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

function formatAction (action: { type: string; target: string; value?: string }): string {
    const type = chalk.bold(action.type)
    const target = chalk.cyan(`"${action.target}"`)
    const value = action.value ? ` = ${chalk.yellow(`"${action.value}"`)}` : ''
    return `${type} ${target}${value}`
}

function formatActionResult (ar: ActionResult): string {
    const icon = ar.success ? chalk.green('✓') : chalk.red('✗')
    const error = (!ar.success && ar.error) ? chalk.red(` (${ar.error})`) : ''
    return `  ${icon} ${formatAction(ar.action)}${error}`
}

function formatResult (result: AgentResult): string {
    const lines: string[] = []

    if (result.steps?.length) {
        for (const step of result.steps) {
            if (result.steps.length > 1) {
                lines.push(chalk.dim(`  Step ${step.step}:`))
            }
            for (const ar of step.actions) {
                lines.push(formatActionResult(ar))
            }
        }
    } else if (result.actions?.length) {
        for (const action of result.actions) {
            lines.push(`  ${chalk.green('✓')} ${formatAction(action)}`)
        }
    }

    if (lines.length === 0) {
        lines.push(chalk.dim('  No actions were executed'))
    }

    if (result.goalAchieved) {
        lines.push(chalk.green(`  Goal achieved in ${result.totalSteps} step(s)`))
    } else {
        lines.push(chalk.yellow(`  Goal not confirmed (${result.totalSteps} step(s) used)`))
    }

    return lines.join('\n')
}

function createSpinner () {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    let i = 0
    let timer: ReturnType<typeof setInterval> | null = null
    let currentText = ''

    return {
        start (text: string) {
            currentText = text
            process.stdout.write(`  ${chalk.cyan(frames[0])} ${chalk.dim(text)}`)
            timer = setInterval(() => {
                i = (i + 1) % frames.length
                readline.clearLine(process.stdout, 0)
                readline.cursorTo(process.stdout, 0)
                process.stdout.write(`  ${chalk.cyan(frames[i])} ${chalk.dim(currentText)}`)
            }, 80)
        },
        stop () {
            if (timer) {
                clearInterval(timer)
                timer = null
            }
            readline.clearLine(process.stdout, 0)
            readline.cursorTo(process.stdout, 0)
        }
    }
}

export async function handler (argv: AgentCommandArguments) {
    const caps = await getCapabilities(argv)

    /**
     * Filter agent-specific args out of WebDriver session options and
     * default port to 4723 for Appium (mobile) sessions.
     */
    const remoteOpts: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(argv)) {
        if (!AGENT_SPECIFIC_ARGS.has(key)) {
            remoteOpts[key] = value
        }
    }
    const isMobileSession = /android|ios/i.test(argv.option) || /\.(apk|app|ipa)$/.test(argv.option)
    if (isMobileSession && !remoteOpts.port) {
        remoteOpts.port = 4723
    }

    const client = await remote({ ...remoteOpts, ...caps } as Parameters<typeof remote>[0])

    global.$ = client.$.bind(client)
    global.$$ = client.$$.bind(client)
    global.browser = client

    try {
        const { default: AgentService, PROVIDER_DEFAULTS } = await import('wdio-agent-service')
        const serviceConfig: Record<string, unknown> = {
            provider: argv.provider,
            maxSteps: argv.maxSteps,
            maxActions: argv.maxActions,
            timeout: argv.timeout,
            toonFormat: argv.toonFormat,
            contextWindow: argv.contextWindow,
            ...(argv.model && { model: argv.model }),
            ...(argv.token && { token: argv.token }),
            ...(argv.providerUrl && { providerUrl: argv.providerUrl }),
        }

        const agentService = new AgentService(serviceConfig)
        agentService.before({}, [], client)

        if (typeof (client as WebdriverIO.Browser).agent !== 'function') {
            throw new Error(
                'browser.agent() was not registered. ' +
                'This may indicate an incompatible version of wdio-agent-service.'
            )
        }

        const resolvedModel = argv.model || PROVIDER_DEFAULTS[argv.provider]?.model || '(provider default)'
        console.log(chalk.bold('\n🤖 WebdriverIO Agent REPL\n'))
        console.log(`  Provider: ${chalk.cyan(argv.provider)}`)
        console.log(`  Model:    ${chalk.cyan(resolvedModel)}`)
        console.log(`  Steps:    ${chalk.cyan(String(argv.maxSteps))}  Actions: ${chalk.cyan(String(argv.maxActions))}`)
        console.log('')
        console.log(chalk.dim('  Commands:  :js <code>  :url  :screenshot <path>  .exit'))
        console.log('')
    } catch (err) {
        const message = errorMessage(err)
        if (message.includes('API') || message.includes('key') || message.includes('token') || message.includes('auth')) {
            console.error(chalk.red(`\nAgent initialization failed: ${message}`))
            console.error(chalk.yellow('Hint: Provide an API key via --token or the provider\'s env var (e.g. ANTHROPIC_API_KEY)\n'))
        } else {
            console.error(chalk.red(`\nFailed to initialize agent service: ${message}\n`))
        }
        await client.deleteSession()
        return
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: chalk.bold('agent> '),
    })

    let processing = false
    let activeSpinner: ReturnType<typeof createSpinner> | null = null

    /**
     * Catch unhandled rejections from internal WebDriver BiDi commands
     * that escape the promise chain to prevent REPL crashes.
     */
    const onUnhandledRejection = (err: unknown) => {
        if (activeSpinner) {
            activeSpinner.stop()
            activeSpinner = null
        }
        const message = errorMessage(err)
        console.error(chalk.red(`\n  Error: ${message}`))
        if (message.includes('timed out')) {
            console.error(chalk.yellow('  Hint: A browser command timed out. The page may still be loading — try again.'))
        }
        processing = false
        rl.prompt()
    }
    process.on('unhandledRejection', onUnhandledRejection)

    rl.prompt()

    rl.on('line', async (line: string) => {
        const input = line.trim()

        if (!input) {
            rl.prompt()
            return
        }

        if (processing) {
            return
        }

        if (input === '.exit') {
            rl.close()
            return
        }

        if (input.startsWith(':js ')) {
            const code = input.slice(4)
            try {
                const fn = new Function('browser', '$', '$$', `return (async () => { ${code.startsWith('await') || code.startsWith('return') ? code : `return ${code}`} })()`)
                const result = await fn(client, client.$.bind(client), client.$$.bind(client))
                if (result !== undefined) {
                    console.log(result)
                }
            } catch (err) {
                console.error(chalk.red(errorMessage(err)))
            }
            rl.prompt()
            return
        }

        if (input === ':url') {
            try {
                const url = await client.getUrl()
                console.log(`Current URL: ${chalk.cyan(url)}`)
            } catch (err) {
                console.error(chalk.red(errorMessage(err)))
            }
            rl.prompt()
            return
        }

        if (input.startsWith(':screenshot')) {
            const filePath = input.split(/\s+/)[1] || `screenshot-${Date.now()}.png`
            try {
                await client.saveScreenshot(filePath)
                console.log(`Screenshot saved: ${chalk.cyan(filePath)}`)
            } catch (err) {
                console.error(chalk.red(errorMessage(err)))
            }
            rl.prompt()
            return
        }

        processing = true
        const spinner = createSpinner()
        activeSpinner = spinner
        spinner.start('Thinking...')

        try {
            const result = await (client as WebdriverIO.Browser).agent(input) as AgentResult
            spinner.stop()
            activeSpinner = null
            console.log(formatResult(result))
        } catch (err) {
            spinner.stop()
            activeSpinner = null
            const message = errorMessage(err)
            console.error(chalk.red(`  Error: ${message}`))

            if (message.includes('fetch') || message.includes('ECONNREFUSED') || message.includes('network')) {
                console.error(chalk.yellow('  Hint: Check that your LLM provider is running and accessible'))
            }
            if (message.includes('timed out') || message.includes('Timeout')) {
                console.error(chalk.yellow('  Hint: A command timed out. The page may still be loading — try again.'))
            }
        } finally {
            processing = false
        }

        rl.prompt()
    })

    rl.on('close', async () => {
        process.removeListener('unhandledRejection', onUnhandledRejection)
        console.log(chalk.dim('\nClosing browser session...'))
        await client.deleteSession()
        process.exit(0)
    })
}

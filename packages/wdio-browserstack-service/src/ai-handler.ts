import path from 'node:path'
import fs from 'node:fs'
import url from 'node:url'
import aiSDK from '@browserstack/ai-sdk-node'
import { BStackLogger } from './bstackLogger.js'
import { SUPPORTED_BROWSERS_FOR_AI, BSTACK_SERVICE_VERSION, BSTACK_TCG_AUTH_RESULT, HUB_TCG_MAP, BSTACK_TCG_URL, TIMEOUT_DURATION } from './constants.js'
import { handleHealingInstrumentation } from './instrumentation/funnelInstrumentation.js'
import { v4 as uuidv4 } from 'uuid'

import type { Capabilities } from '@wdio/types'
import type BrowserStackConfig from './config.js'
import type { Options } from '@wdio/types'
import type { BrowserstackHealing, NLToSteps } from '@browserstack/ai-sdk-node'
import { getBrowserStackUserAndKey, getNextHub, isBrowserstackInfra } from './util.js'
import type { BrowserstackOptions } from './types.js'
import type AccessibilityHandler from './accessibility-handler.js'

class AiHandler {
    authResult: BrowserstackHealing.InitSuccessResponse | BrowserstackHealing.InitErrorResponse
    wdioBstackVersion: string
    constructor() {
        this.authResult = JSON.parse(process.env[BSTACK_TCG_AUTH_RESULT] || '{}')
        this.wdioBstackVersion = BSTACK_SERVICE_VERSION
    }

    async authenticateUser(user: string, key: string) {
        const tcgUrl = await this.getTcgUrl() as string
        return await aiSDK.BrowserstackHealing.init(key, user, tcgUrl, this.wdioBstackVersion)
    }

    updateCaps(
        authResult: BrowserstackHealing.InitSuccessResponse | BrowserstackHealing.InitErrorResponse,
        options: BrowserstackOptions,
        caps: Array<Capabilities.RemoteCapability> | Capabilities.RemoteCapability
    ) {

        if (Array.isArray(caps)) {
            const newCaps= aiSDK.BrowserstackHealing.initializeCapabilities(caps[0])
            caps[0] = newCaps
        } else if (typeof caps === 'object') {
            caps = aiSDK.BrowserstackHealing.initializeCapabilities(caps)
        }

        return caps
    }

    async setToken(sessionId: string, sessionToken: string, tcgUrl: string){
        await aiSDK.BrowserstackHealing.setToken(sessionId, sessionToken, tcgUrl)
    }

    async installFirefoxExtension(browser: WebdriverIO.Browser){
        const __dirname =  url.fileURLToPath(new URL('.', import.meta.url))
        const extensionPath = path.resolve(__dirname, aiSDK.BrowserstackHealing.getFirefoxAddonPath())
        const extFile = fs.readFileSync(extensionPath)
        await browser.installAddOn(extFile.toString('base64'), true)
    }

    async handleHealing(orginalFunc: (arg0: string, arg1: string) => any, using: string, value: string, browser: WebdriverIO.Browser, options: BrowserstackOptions, tcgUrl: string){
        const sessionId = browser.sessionId

        // a utility function to escape single and double quotes
        const escapeString = (str: string) => str.replace(/'/g, "\\'").replace(/"/g, '\\"')
        const tcgRegion = (tcgUrl.includes('.') && tcgUrl.includes('-')) ? tcgUrl.split('.')[0].split('-')[1] : 'use'

        const tcgDetails = escapeString(JSON.stringify({
            region: tcgRegion,
            tcgUrls: {
                [tcgRegion]: {
                    endpoint: tcgUrl.split('://')[1]
                }
            }
        }))

        const locatorType = escapeString(using)
        const locatorValue = escapeString(value)

        this.authResult = this.authResult as BrowserstackHealing.InitSuccessResponse

        try {
            const result = await orginalFunc(using, value)
            if (!result.error) {
                const script = await aiSDK.BrowserstackHealing.logData(locatorType, locatorValue, undefined, undefined, this.authResult.groupId, sessionId, undefined, tcgDetails)
                if (script) {
                    await browser.execute(script)
                }
                return result
            }
            if (options.selfHeal === true && this.authResult.isHealingEnabled) {
                BStackLogger.info('findElement failed, trying to heal')
                const script = await aiSDK.BrowserstackHealing.healFailure(locatorType, locatorValue, undefined, undefined, this.authResult.userId, this.authResult.groupId, sessionId, undefined, undefined, this.authResult.isGroupAIEnabled, tcgDetails)
                if (script) {
                    await browser.execute(script)
                    const tcgData = await aiSDK.BrowserstackHealing.pollResult(tcgUrl, sessionId, this.authResult.sessionToken)
                    if (tcgData && tcgData.selector && tcgData.value){
                        const healedResult = await orginalFunc(tcgData.selector, tcgData.value)
                        BStackLogger.info('Healing worked, element found: ' + tcgData.selector + ': ' + tcgData.value)
                        return healedResult.error ? result : healedResult
                    }
                }
            }
        } catch (err) {
            if (options.selfHeal === true) {
                BStackLogger.warn('Something went wrong while healing. Disabling healing for this command')
            } else {
                BStackLogger.warn('Error in findElement: ' + err + 'using: ' + using + 'value: ' + value)
            }
        }
        return await orginalFunc(using, value)
    }

    addMultiRemoteCaps (
        authResult: BrowserstackHealing.InitSuccessResponse | BrowserstackHealing.InitErrorResponse,
        config: Options.Testrunner,
        browserStackConfig: BrowserStackConfig,
        options: BrowserstackOptions,
        caps: any,
        browser: string
    ) {
        if ( caps[browser].capabilities &&
            !(isBrowserstackInfra(caps[browser])) &&
            SUPPORTED_BROWSERS_FOR_AI.includes(caps[browser]?.capabilities?.browserName?.toLowerCase())
        ) {
            const innerConfig = getBrowserStackUserAndKey(config, options)
            if (innerConfig?.user && innerConfig.key) {
                handleHealingInstrumentation(authResult, browserStackConfig, options.selfHeal)
                caps[browser].capabilities = this.updateCaps(authResult, options, caps[browser].capabilities)
            }
        }
    }

    handleMultiRemoteSetup(
        authResult: BrowserstackHealing.InitSuccessResponse | BrowserstackHealing.InitErrorResponse,
        config: Options.Testrunner,
        browserStackConfig: BrowserStackConfig,
        options: BrowserstackOptions,
        caps: any,
    ) {
        const browserNames = Object.keys(caps)
        for (let i = 0; i < browserNames.length; i++) {
            const browser = browserNames[i]
            this.addMultiRemoteCaps(authResult, config, browserStackConfig, options, caps, browser)
        }
    }

    async setup(
        config: Options.Testrunner,
        browserStackConfig: BrowserStackConfig,
        options: BrowserstackOptions,
        caps: any,
        isMultiremote: boolean
    ) {
        try {
            // const innerConfig = getBrowserStackUserAndKey(config, options)
            // if (innerConfig?.user && innerConfig.key) {
            // const authResult = await this.authenticateUser(innerConfig.user, innerConfig.key)
            // process.env[BSTACK_TCG_AUTH_RESULT] = JSON.stringify(authResult)
            const authResult = JSON.parse(process.env[BSTACK_TCG_AUTH_RESULT] || '{}')
            if (!isMultiremote && SUPPORTED_BROWSERS_FOR_AI.includes(caps?.browserName?.toLowerCase())) {

                handleHealingInstrumentation(authResult, browserStackConfig, options.selfHeal)
                this.updateCaps(authResult, options, caps)

            } else if (isMultiremote) {
                this.handleMultiRemoteSetup(authResult, config, browserStackConfig, options, caps)
            }
            // }

        } catch (err) {
            if (options.selfHeal === true) {
                BStackLogger.warn(`Error while initiliazing Browserstack healing Extension ${err}`)
            }
        }

        return caps
    }

    async handleSelfHeal(options: BrowserstackOptions, browser: WebdriverIO.Browser, tcgUrl: string) {

        if ((browser.capabilities as Capabilities.BrowserStackCapabilities)?.browserName?.toLowerCase() === 'firefox') {
            await this.installFirefoxExtension(browser)
        }

        if (SUPPORTED_BROWSERS_FOR_AI.includes((browser.capabilities as Capabilities.BrowserStackCapabilities)?.browserName?.toLowerCase() as string)) {
            const authInfo = this.authResult as BrowserstackHealing.InitSuccessResponse

            if (Object.keys(authInfo).length === 0 && options.selfHeal === true) {
                BStackLogger.debug('TCG Auth result is empty')
                return
            }

            const { isAuthenticated, sessionToken, defaultLogDataEnabled } = authInfo

            if (isAuthenticated && (defaultLogDataEnabled === true || options.selfHeal === true)) {
                await this.setToken(browser.sessionId, sessionToken, tcgUrl)

                browser.overwriteCommand('findElement' as any, async (orginalFunc: (arg0: string, arg1: string) => any, using: string, value: string) => {
                    return await this.handleHealing(orginalFunc, using, value, browser, options, tcgUrl)
                })
            }
        }
    }

    async selfHeal(options: BrowserstackOptions, caps: Capabilities.RemoteCapability, browser: WebdriverIO.Browser, tcgUrl: string) {
        try {

            const multiRemoteBrowsers = Object.keys(caps).filter(e => Object.keys(browser).includes(e))
            if (multiRemoteBrowsers.length > 0) {
                for (let i = 0; i < multiRemoteBrowsers.length; i++) {
                    const remoteBrowser = (browser as any)[multiRemoteBrowsers[i]]
                    await this.handleSelfHeal(options, remoteBrowser, tcgUrl)
                }
            } else {
                await this.handleSelfHeal(options, browser, tcgUrl)
            }

        } catch (err) {
            if (options.selfHeal === true) {
                BStackLogger.warn(`Error while setting up self-healing: ${err}. Disabling healing for this session.`)
            }
        }
    }

    async getTcgUrl(): Promise<string | null>  {
        try {

            if (process.env[BSTACK_TCG_URL]) {
                return process.env[BSTACK_TCG_URL] as string
            }

            const nextHub: string | null = await getNextHub()

            if (nextHub && HUB_TCG_MAP[nextHub]) {
                const tcgUrl = HUB_TCG_MAP[nextHub]
                process.env[BSTACK_TCG_URL] = tcgUrl
                return tcgUrl
            }

            return null

        } catch (error) {
            return null
        }
    }

    async getAuthToken(): Promise<string> {

        const authResult = JSON.parse(process.env[BSTACK_TCG_AUTH_RESULT] || '{}')
        if (authResult.isAuthenticated) {
            return authResult.sessionToken
        }
        return ''
    }

    getFrameworkImpl(browser: any): NLToSteps.NLToStepsFrameworkImpl {
        return {
            executeScript: async (script: (...data: any) => any, args: any[]) => {
                return await browser.execute(script, ...args)
            },
            getBrowser() {
                return browser.capabilities.browserName
            }
        }
    }

    async handleNLToStepsStart(userInput: string, browser: any, _accessibilityHandler?: AccessibilityHandler) {
        if (!(SUPPORTED_BROWSERS_FOR_AI.includes((browser.capabilities.browserName)))) {
            BStackLogger.warn('Browserstack AI is not supported for this browser')
            return
        }

        try {
            let timeoutTimer: NodeJS.Timeout | undefined

            const createTimeoutPromise = () => new Promise<never>(() => {
                timeoutTimer = setTimeout(() => {
                    throw new Error(
                        `BrowserStack AI execution timed out after ${TIMEOUT_DURATION / 1000} seconds.`
                    )
                }, TIMEOUT_DURATION)
            })

            const nlToStepsPromise = aiSDK.NLToSteps.start({
                id: 'webdriverio-' + uuidv4(),
                objective: userInput,
                waitCallback: async (waitAction: NLToSteps.NLToStepsWaitAction) => {
                    console.log('waitAction:', JSON.stringify(waitAction))

                    if (timeoutTimer) {
                        clearTimeout(timeoutTimer)
                    }

                    createTimeoutPromise()

                    if (_accessibilityHandler) {
                        await _accessibilityHandler.validateAccessibility()
                        // TODO: Add accessibility commandsToWrap logic here
                    }

                    return true
                },
                authMethod: this.getAuthToken,
                waitAfterActions: true,
                frameworkImplementation: this.getFrameworkImpl(browser)
            })

            const out = await Promise.race([
                nlToStepsPromise,
                createTimeoutPromise()
            ])

            if (timeoutTimer) {
                clearTimeout(timeoutTimer)
            }

            if (out.state === 'SUCCESS') {
                BStackLogger.info(`The query has been successfully executed in the ${browser.capabilities.browserName} browser`)
            } else {
                BStackLogger.warn(`The query could not be executed in the ${browser.capabilities.browserName} browser. Reason: ${out.message}`)
            }

            return out

        } catch (error: any) {
            BStackLogger.error('Error in browser.ai: ' + (error.message || error))
        }
    }

    async testNLToStepsStart(userInput: string, browser: any, caps: Capabilities.RemoteCapability, _accessibilityHandler?: AccessibilityHandler) {

        const multiRemoteBrowsers = Object.keys(caps).filter(e => Object.keys(browser).includes(e))
        if (multiRemoteBrowsers.length > 0) {
            const result = multiRemoteBrowsers.map(() => ({ state: 'FAILED' }))

            for (let i = 0; i < multiRemoteBrowsers.length; i++) {
                if (!(SUPPORTED_BROWSERS_FOR_AI.includes((browser as any)[multiRemoteBrowsers[i]].capabilities.browserName))) {
                    BStackLogger.warn('Browserstack AI is not supported for this browser')
                    return
                }
                result[i] = await this.handleNLToStepsStart(userInput, (browser as any)[multiRemoteBrowsers[i]], _accessibilityHandler)
            }
            return result
        }

        if (!(SUPPORTED_BROWSERS_FOR_AI.includes((browser.capabilities.browserName))) ) {
            BStackLogger.warn('Browserstack AI is not supported for this browser')
            return
        }
        return await this.handleNLToStepsStart(userInput, browser, _accessibilityHandler)
    }
}

export default new AiHandler()

import path from 'node:path'
import fs from 'node:fs'
import url from 'node:url'
import aiSDK from '@browserstack/ai-sdk-node'
import { BStackLogger } from './bstackLogger.js'
import { BSTACK_SERVICE_VERSION, BSTACK_TCG_AUTH_RESULT, HUB_TCG_MAP, BSTACK_TCG_URL, TIMEOUT_DURATION } from './constants.js'
import { handleHealingInstrumentation, nlToStepsInstrumentation } from './instrumentation/funnelInstrumentation.js'
import { v4 as uuidv4 } from 'uuid'

import type { Capabilities } from '@wdio/types'
import type BrowserStackConfig from './config.js'
import type { Options } from '@wdio/types'
import type { BrowserstackHealing, NLToSteps } from '@browserstack/ai-sdk-node'
import { getBrowserStackUserAndKey, getNextHub, isBrowserstackInfra, hasDeviceName } from './util.js'
import type { BrowserstackOptions } from './types.js'

class AiHandler {
    authResult: BrowserstackHealing.InitSuccessResponse | BrowserstackHealing.InitErrorResponse
    wdioBstackVersion: string
    timeoutTimer: NodeJS.Timeout | undefined
    constructor() {
        this.authResult = JSON.parse(process.env[BSTACK_TCG_AUTH_RESULT] || '{}')
        this.wdioBstackVersion = BSTACK_SERVICE_VERSION
        this.timeoutTimer = undefined
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

        if (Array.isArray(caps) && !hasDeviceName(caps[0])) {
            const newCaps= aiSDK.BrowserstackHealing.initializeCapabilities(caps[0])
            caps[0] = newCaps
        } else if (typeof caps === 'object' && !hasDeviceName(caps)) {
            caps = aiSDK.BrowserstackHealing.initializeCapabilities(caps)
        } else if (options.selfHeal === true && hasDeviceName(caps)) {
            BStackLogger.warn('Self-healing is not supported for mobile devices')
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
        const browserDetails = {
            browserName: caps[browser]?.capabilities?.browserName?.toLowerCase() as string,
            version: caps[browser]?.capabilities?.browserVersion as string
        }
        if ( caps[browser].capabilities &&
            !(isBrowserstackInfra(caps[browser])) &&
            aiSDK.AISDK.checkExtensionCompatibility(browserDetails)
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

            if (!isMultiremote) {
                const browserDetails = {
                    browserName: caps?.browserName?.toLowerCase() as string,
                    version: caps?.browserVersion as string
                }
                if (aiSDK.AISDK.checkExtensionCompatibility(browserDetails)) {
                    handleHealingInstrumentation(authResult, browserStackConfig, options.selfHeal)
                    this.updateCaps(authResult, options, caps)
                }
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

            if (!hasDeviceName(browser.capabilities)) {
                await this.installFirefoxExtension(browser)
            } else if (options.selfHeal === true && hasDeviceName(browser.capabilities)) {
                BStackLogger.warn('Self-healing is not supported for mobile devices')
                return
            }
        }

        const browserDetails = {
            browserName: (browser.capabilities as Capabilities.BrowserStackCapabilities)?.browserName?.toLowerCase() as string,
            version: (browser.capabilities as Capabilities.BrowserStackCapabilities)?.browserVersion as string
        }

        if (aiSDK.AISDK.checkExtensionCompatibility(browserDetails)) {
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

    async handleNLToStepsStart(
        userInput: string,
        browser: any,
        tcgUrl: string,
        config: BrowserStackConfig
    ): Promise<{ state?: string; value?: any; message: string; success: boolean; }> {
        const browserDetails = {
            browserName: browser.capabilities.browserName,
            version: browser.capabilities.browserVersion
        }
        if (!(aiSDK.AISDK.checkExtensionCompatibility(browserDetails))) {
            BStackLogger.warn('Browserstack AI is not supported for this browser')
            return { message: 'UNSUPPORTED_BROWSER', success: false }
        } else if (hasDeviceName(browser.capabilities)) {
            BStackLogger.warn('Browserstack AI is not supported for mobile devices')
            return { message: 'UNSUPPORTED_DEVICE', success: false }
        }

        aiSDK.AISDK.configure({
            domain: tcgUrl,
            platform: hasDeviceName(browser.capabilities) ? 'mobile' : 'desktop',
            connector: 'extension',
            client: 'webdriverio'
        })

        const driverAiReturn = {
            value: '',
            success: false,
            message: 'browser.ai objective pending'
        }

        const createTimeoutPromise = () => new Promise<never>(() => {
            nlToStepsInstrumentation(config, 'timeout')
            this.timeoutTimer = setTimeout(() => {
                BStackLogger.error('BrowserStack AI execution timed out')
                throw new Error(
                    `BrowserStack AI execution timed out after ${TIMEOUT_DURATION / 1000} seconds.`
                )
            }, TIMEOUT_DURATION)
        })

        const nlToStepsPromise = aiSDK.NLToSteps.start({
            id: 'webdriverio-' + uuidv4(),
            objective: userInput,
            supportedActions: ['referUserToElement'],
            waitCallback: async (waitAction: NLToSteps.NLToStepsWaitAction) => {
                console.log('waitAction:', JSON.stringify(waitAction))

                if (this.timeoutTimer) {
                    clearTimeout(this.timeoutTimer)
                }
                createTimeoutPromise()

                if (waitAction.type === 'STEP') {
                    const step = waitAction.request as aiSDK.NLToSteps.NLToStepsAction
                    if (step.action_type === 'referUserToElement') {
                        if (!driverAiReturn.value && step.element.extracted_value) {
                            driverAiReturn.value = step.element.extracted_value as string
                        }
                    }
                    return true
                }

                return true
            },
            authMethod: this.getAuthToken,
            waitAfterActions: true,
            waitForCustomActions: true,
            frameworkImplementation: this.getFrameworkImpl(browser)
        })

        const out = await Promise.race([
            nlToStepsPromise,
            createTimeoutPromise()
        ])

        if (this.timeoutTimer && out) {
            clearTimeout(this.timeoutTimer)
        }

        if (out.state !== 'SUCCESS') {
            nlToStepsInstrumentation(config, out.failReason)
            throw new Error(out.errorName, {
                cause: out.failReason
            })

        }

        driverAiReturn.success = true
        driverAiReturn.message = 'browser.ai objective completed'
        return driverAiReturn
    }

    async testNLToStepsStart(userInput: string, browser: any, caps: Capabilities.RemoteCapability, tcgUrl: string, config: BrowserStackConfig) {

        const multiRemoteBrowsers = Object.keys(caps).filter(e => Object.keys(browser).includes(e))
        if (multiRemoteBrowsers.length > 0) {
            const result = multiRemoteBrowsers.map(() => ({ success: false, message: 'Execution pending' }))

            for (let i = 0; i < multiRemoteBrowsers.length; i++) {
                const browserDetails = {
                    browserName: (browser as any)[multiRemoteBrowsers[i]].capabilities.browserName,
                    version: (browser as any)[multiRemoteBrowsers[i]].capabilities.browserVersion
                }
                if (!(aiSDK.AISDK.checkExtensionCompatibility(browserDetails))) {
                    BStackLogger.warn('Browserstack AI is not supported for this browser')
                    return
                }
                result[i] = await this.handleNLToStepsStart(userInput, (browser as any)[multiRemoteBrowsers[i]], tcgUrl, config)
            }
            return result
        }

        const browserDetails = {
            browserName: browser.capabilities.browserName,
            version: browser.capabilities.browserVersion
        }
        if (!(aiSDK.AISDK.checkExtensionCompatibility(browserDetails))) {
            BStackLogger.warn('Browserstack AI is not supported for this browser')
            return
        }
        return await this.handleNLToStepsStart(userInput, browser, tcgUrl, config)
    }
}

export default new AiHandler()

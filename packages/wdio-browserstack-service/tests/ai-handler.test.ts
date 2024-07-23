/// <reference path="../../webdriverio/src/@types/async.d.ts" />
import path from 'node:path'

import { describe, expect, it, vi, beforeEach } from 'vitest'
import aiSDK from '@browserstack/ai-sdk-node'

import AiHandler from '../src/ai-handler.js'
import * as bstackLogger from '../src/bstackLogger.js'
import * as funnelInstrumentation from '../src/instrumentation/funnelInstrumentation.js'
import type { Capabilities } from '@wdio/types'

// Mock only the external dependency
vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))
vi.mock('@browserstack/ai-sdk-node')
vi.useFakeTimers().setSystemTime(new Date('2020-01-01'))
vi.mock('uuid', () => ({ v4: () => '123456789' }))

const bstackLoggerSpy = vi.spyOn(bstackLogger.BStackLogger, 'logToFile')
bstackLoggerSpy.mockImplementation(() => {})

describe('AiHandler', () => {
    let config: any
    let browser: any

    beforeEach(() => {
        config = {
            user: 'foobaruser',
            key: '12345',
            selfHeal: true // Default to true
        }

        browser = {
            sessionId: 'test-session-id',
            execute: vi.fn(),
            installAddOn: vi.fn(),
            overwriteCommand: vi.fn()
        }
    })

    describe('authenticateUser', () => {
        it('should authenticate user', async () => {
            const authResponse = {
                message: 'Authentication successful',
                isAuthenticated: true,
                defaultLogDataEnabled: true,
                isHealingEnabled: true,
                sessionToken: 'test-token',
                groupId: 123123,
                userId: 342423,
                isGroupAIEnabled: true,
            }

            const initSpy = vi.spyOn(aiSDK.BrowserstackHealing, 'init')
                .mockReturnValue(Promise.resolve(authResponse) as any)

            const result = await AiHandler.authenticateUser(config)

            expect(initSpy).toHaveBeenCalledTimes(1)
            expect(initSpy).toHaveBeenCalledWith(
                config.key,
                config.user,
                'https://tcg.browserstack.com',
                expect.any(String)
            )
            expect(result).toEqual(authResponse)
        })
    })

    describe('updateCaps', () => {
        it('should add the AI extension to capabilities', async () => {
            const authResult = {
                isAuthenticated: true,
                defaultLogDataEnabled: true,
            } as any

            const caps = {
                'goog:chromeOptions': {}
            }
            const mockExtension = 'mock-extension'

            vi.spyOn(aiSDK.BrowserstackHealing, 'initializeCapabilities')
                .mockReturnValue({ ...caps, 'goog:chromeOptions': { extensions: [mockExtension] } })

            const updatedCaps = await AiHandler.updateCaps(authResult, config, caps)

            expect(updatedCaps['goog:chromeOptions'].extensions).toEqual([mockExtension])
        })
    })

    describe('handleHealing', () => {
        it('should attempt healing if findElement fails', async () => {
            const originalFunc = vi.fn().mockReturnValueOnce({ error: 'no such element' })
                .mockReturnValueOnce({})

            const healFailureResponse = { script: 'healing-script' }
            const pollResultResponse = { selector: 'css selector', value: '.healed-element' }

            AiHandler['authResult'] = {
                isAuthenticated: true,
                isHealingEnabled: true,
                sessionToken: 'test-session-token',
                groupId: 123123,
                userId: 342423,
                isGroupAIEnabled: true
            } as any

            vi.spyOn(aiSDK.BrowserstackHealing, 'healFailure')
                .mockResolvedValue(healFailureResponse.script as string)
            vi.spyOn(aiSDK.BrowserstackHealing, 'pollResult')
                .mockResolvedValue(pollResultResponse as any)
            vi.spyOn(aiSDK.BrowserstackHealing, 'logData')
                .mockResolvedValue('logging-script' as string)

            const result = await AiHandler.handleHealing(originalFunc, 'id', 'some-id', browser, config)

            expect(aiSDK.BrowserstackHealing.healFailure).toHaveBeenCalledTimes(1)
            expect(aiSDK.BrowserstackHealing.pollResult).toHaveBeenCalledTimes(1)
            expect(originalFunc).toHaveBeenCalledTimes(2)
            expect(browser.execute).toHaveBeenCalledWith('healing-script')
            expect(result).toEqual({})
        })

        it('should attempt logging if findElement successfully runs', async () => {
            const originalFunc = vi.fn().mockReturnValueOnce({ element: 'mock-element' })
                .mockReturnValueOnce({})

            AiHandler['authResult'] = {
                isAuthenticated: true,
                isHealingEnabled: true,
                sessionToken: 'test-session-token',
                groupId: 123123,
                userId: 342423,
                isGroupAIEnabled: true
            } as any

            vi.spyOn(aiSDK.BrowserstackHealing, 'logData')
                .mockResolvedValue('logging-script' as any)

            const result = await AiHandler.handleHealing(originalFunc, 'id', 'some-id', browser, config)

            expect(originalFunc).toHaveBeenCalledTimes(1)
            expect(browser.execute).toHaveBeenCalledWith('logging-script')
            expect(result).toEqual({ 'element': 'mock-element' })
        })

        it('should call originalFunc if there is an error in try block', async () => {
            const originalFunc = vi.fn().mockImplementationOnce(() => {
                throw new Error('Some error occurred.')
            })

            AiHandler['authResult'] = {
                isAuthenticated: true,
                isHealingEnabled: true,
                sessionToken: 'test-session-token',
                groupId: 123123,
                userId: 342423,
                isGroupAIEnabled: true
            } as any

            const debugSpy = vi.spyOn(bstackLogger.BStackLogger, 'debug')

            const result = await AiHandler.handleHealing(originalFunc, 'id', 'some-id', browser, config)

            expect(originalFunc).toHaveBeenCalledTimes(2)
            expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('Error in findElement'))
            expect(result).toEqual(undefined)
        })
    })

    describe('setup', () => {
        it('should authenticate user and update capabilities for supported browser', async () => {
            const caps = { browserName: 'chrome' }
            const mockAuthResult = {
                isAuthenticated: true,
                sessionToken: 'mock-session-token',
                defaultLogDataEnabled: true,
                isHealingEnabled: true,
                groupId: 123123,
                userId: 342423,
                isGroupAIEnabled: true,
            }

            const authenticateUserSpy = vi.spyOn(AiHandler, 'authenticateUser')
                .mockResolvedValue(mockAuthResult as any)
            const handleHealingInstrumentationSpy = vi.spyOn(funnelInstrumentation, 'handleHealingInstrumentation')
            const updateCapsSpy = vi.spyOn(AiHandler, 'updateCaps')
                .mockResolvedValue({ ...caps, 'goog:chromeOptions': { extensions: ['mock-extension'] } })

            const mockExtension = 'mock-extension'
            vi.spyOn(aiSDK.BrowserstackHealing, 'initializeCapabilities')
                .mockReturnValue({ ...caps, 'goog:chromeOptions': { extensions: [mockExtension] } })

            const emptyObj = {} as any
            const updatedCaps = await AiHandler.setup(config, emptyObj, emptyObj, caps)

            expect(authenticateUserSpy).toHaveBeenCalledTimes(1)
            expect(handleHealingInstrumentationSpy).toHaveBeenCalledTimes(1)
            expect(updateCapsSpy).toHaveBeenCalledTimes(1)
            expect(updatedCaps['goog:chromeOptions'].extensions).toEqual([mockExtension])
        })

        it('should skip setup if accessKey is not present', async () => {
            config.key = ''
            const caps = { browserName: 'chrome' }

            const authenticateUserSpy = vi.spyOn(AiHandler, 'authenticateUser')
            const handleHealingInstrumentationSpy = vi.spyOn(funnelInstrumentation, 'handleHealingInstrumentation')
            const updateCapsSpy = vi.spyOn(AiHandler, 'updateCaps')

            const emptyObj = {} as any
            const updatedCaps = await AiHandler.setup(config, emptyObj, emptyObj, caps)

            expect(authenticateUserSpy).not.toHaveBeenCalled()
            expect(handleHealingInstrumentationSpy).not.toHaveBeenCalled()
            expect(updateCapsSpy).not.toHaveBeenCalled()
            expect(updatedCaps).toEqual(caps) // Expect caps to remain unchanged
        })

        it('should skip setup if userName is not present', async () => {
            config.user = ''
            const caps = { browserName: 'chrome' }

            const authenticateUserSpy = vi.spyOn(AiHandler, 'authenticateUser')
            const handleHealingInstrumentationSpy = vi.spyOn(funnelInstrumentation, 'handleHealingInstrumentation')
            const updateCapsSpy = vi.spyOn(AiHandler, 'updateCaps')

            const emptyObj = {} as any
            const updatedCaps = await AiHandler.setup(config, emptyObj, emptyObj, caps)

            expect(authenticateUserSpy).not.toHaveBeenCalled()
            expect(handleHealingInstrumentationSpy).not.toHaveBeenCalled()
            expect(updateCapsSpy).not.toHaveBeenCalled()
            expect(updatedCaps).toEqual(caps) // Expect caps to remain unchanged
        })
    })

    describe('selfHeal', () => {
        it('should set token, install extension for Firefox', async () => {
            const caps = { browserName: 'firefox' } as Capabilities.RemoteCapability
            AiHandler['authResult'] = {
                isAuthenticated: true,
                sessionToken: 'mock-session-token',
                defaultLogDataEnabled: true,
                isHealingEnabled: true
            } as any

            const setTokenSpy = vi.spyOn(AiHandler, 'setToken')
            const installFirefoxExtensionSpy = vi.spyOn(AiHandler, 'installFirefoxExtension')

            await AiHandler.selfHeal(config, caps, browser)

            expect(setTokenSpy).toHaveBeenCalledTimes(1)
            expect(setTokenSpy).toHaveBeenCalledWith(browser.sessionId, 'mock-session-token')
            expect(installFirefoxExtensionSpy).toHaveBeenCalledTimes(1)
            expect(installFirefoxExtensionSpy).toHaveBeenCalledWith(browser)
        })

        it('should set token for Chrome', async () => {
            const caps = { browserName: 'chrome' } as Capabilities.RemoteCapability
            AiHandler['authResult'] = {
                isAuthenticated: true,
                sessionToken: 'mock-session-token',
                defaultLogDataEnabled: true,
                isHealingEnabled: true
            } as any

            const setTokenSpy = vi.spyOn(AiHandler, 'setToken')

            await AiHandler.selfHeal(config, caps, browser)

            expect(setTokenSpy).toHaveBeenCalledTimes(1)
            expect(setTokenSpy).toHaveBeenCalledWith(browser.sessionId, 'mock-session-token')
        })

        it('should skip self-healing if authResult is empty', async () => {
            const caps = { browserName: 'chrome' } as Capabilities.RemoteCapability
            AiHandler['authResult'] = {} as any

            const setTokenSpy = vi.spyOn(AiHandler, 'setToken')

            await AiHandler.selfHeal(config, caps, browser)

            expect(setTokenSpy).not.toHaveBeenCalled()
        })

        it('should call overwriteCommand for Chrome', async () => {
            const caps = { browserName: 'chrome' } as Capabilities.RemoteCapability
            AiHandler['authResult'] = {
                isAuthenticated: true,
                sessionToken: 'mock-session-token',
                defaultLogDataEnabled: true,
                isHealingEnabled: true
            } as any

            const setTokenSpy = vi.spyOn(AiHandler, 'setToken')
            const overwriteCommandSpy = vi.spyOn(browser, 'overwriteCommand')

            // Mock logData to return a function (executable script)
            vi.spyOn(aiSDK.BrowserstackHealing, 'logData')
                .mockResolvedValue('logging-script')

            await AiHandler.selfHeal(config, caps, browser)

            expect(setTokenSpy).toHaveBeenCalledTimes(1)
            expect(setTokenSpy).toHaveBeenCalledWith(browser.sessionId, 'mock-session-token')
            expect(overwriteCommandSpy).toHaveBeenCalledTimes(1)
            expect(overwriteCommandSpy).toHaveBeenCalledWith('findElement', expect.any(Function))
        })
    })
})
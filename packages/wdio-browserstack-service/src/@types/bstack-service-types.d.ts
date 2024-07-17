declare namespace WebdriverIO {
    interface Browser {
        getAccessibilityResultsSummary: () => Promise<{ [key: string]: any; }>,
        getAccessibilityResults: () => Promise<Array<{ [key: string]: any; }>>,
        performScan: () => Promise<{ [key: string]: any; } | undefined>,
        ai: () => Prmoise<any>
    }

    interface MultiRemoteBrowser {
        getAccessibilityResultsSummary: () => Promise<{ [key: string]: any; }>,
        getAccessibilityResults: () => Promise<Array<{ [key: string]: any; }>>,
        performScan: () => Promise<{ [key: string]: any; } | undefined>,
        ai: () => Prmoise<any>

    }
}

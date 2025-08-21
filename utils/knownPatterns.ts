// Known BSOD patterns and analysis helpers

export interface PatternInfo {
    signatures: string[];
    commonCulprits: string[];
    recommendations: string[];
    additionalChecks?: string[];
}

export const KNOWN_PATTERNS: Record<string, PatternInfo> = {
    'PAGE_FAULT_IN_NONPAGED_AREA': {
        signatures: [
            'Invalid system memory',
            'corrupted page',
            'bad pool header',
            'memory access violation',
            'nonpaged pool'
        ],
        commonCulprits: [
            'Faulty RAM modules',
            'Corrupted system drivers',
            'Disk errors affecting page file',
            'Incompatible or outdated drivers',
            'Overclocking instability'
        ],
        recommendations: [
            'Run Windows Memory Diagnostic (mdsched.exe)',
            'Check disk health with chkdsk /f /r',
            'Update all drivers, especially storage and chipset',
            'Disable overclocking if applied',
            'Test with one RAM stick at a time'
        ],
        additionalChecks: [
            'Look for ntfs.sys or disk.sys in stack',
            'Check for memory addresses near 0x0',
            'Verify page file configuration'
        ]
    },
    
    'IRQL_NOT_LESS_OR_EQUAL': {
        signatures: [
            'IRQL',
            'dispatch level',
            'raised IRQL',
            'interrupt request level',
            'DISPATCH_LEVEL'
        ],
        commonCulprits: [
            'Driver bugs in kernel mode',
            'Incorrect interrupt handling',
            'Network drivers (especially WiFi)',
            'Antivirus/firewall drivers',
            'USB device drivers'
        ],
        recommendations: [
            'Boot in Safe Mode to isolate driver issues',
            'Uninstall recently installed drivers',
            'Update network adapter drivers',
            'Temporarily disable antivirus software',
            'Check Event Viewer for driver warnings'
        ],
        additionalChecks: [
            'Identify driver at fault from stack trace',
            'Check for ndis.sys or tcpip.sys',
            'Look for third-party .sys files'
        ]
    },
    
    'SYSTEM_SERVICE_EXCEPTION': {
        signatures: [
            'system service',
            'exception in service',
            'KiSystemServiceHandler',
            'system call',
            'win32k.sys'
        ],
        commonCulprits: [
            'Corrupted system files',
            'Graphics drivers',
            'Third-party system utilities',
            'Registry corruption',
            'Malware infection'
        ],
        recommendations: [
            'Run sfc /scannow to check system files',
            'Update graphics drivers from manufacturer',
            'Perform clean boot to isolate software',
            'Run DISM /Online /Cleanup-Image /RestoreHealth',
            'Scan for malware with multiple tools'
        ]
    },
    
    'KERNEL_SECURITY_CHECK_FAILURE': {
        signatures: [
            'security check',
            'kernel security',
            'corruption detected',
            'security cookie',
            'stack buffer overrun'
        ],
        commonCulprits: [
            'Memory corruption',
            'Outdated or incompatible drivers',
            'Overclocking',
            'Failing hardware',
            'BIOS/UEFI issues'
        ],
        recommendations: [
            'Update BIOS/UEFI to latest version',
            'Run Driver Verifier to identify problematic drivers',
            'Check system temperatures',
            'Restore default BIOS settings',
            'Test RAM with MemTest86+'
        ]
    },
    
    'DPC_WATCHDOG_VIOLATION': {
        signatures: [
            'DPC timeout',
            'watchdog',
            'deferred procedure call',
            'DPC routine',
            'exceeded time limit'
        ],
        commonCulprits: [
            'SSD firmware issues',
            'SATA/NVMe driver problems',
            'USB 3.0 controllers',
            'Network adapters',
            'Audio drivers'
        ],
        recommendations: [
            'Update SSD firmware',
            'Change SATA mode in BIOS (AHCI/IDE)',
            'Update storage controller drivers',
            'Disable USB selective suspend',
            'Check for driver updates via Device Manager'
        ]
    },
    
    'VIDEO_TDR_FAILURE': {
        signatures: [
            'TDR failure',
            'display driver',
            'nvlddmkm.sys',
            'atikmdag.sys',
            'igdkmd64.sys',
            'dxgkrnl.sys'
        ],
        commonCulprits: [
            'GPU driver timeout',
            'Overheating graphics card',
            'Corrupted GPU drivers',
            'Hardware acceleration conflicts',
            'Failing GPU'
        ],
        recommendations: [
            'Clean install GPU drivers with DDU',
            'Check GPU temperatures',
            'Increase TDR timeout in registry',
            'Disable hardware acceleration in browsers',
            'Test with different GPU if available'
        ]
    },
    
    'CRITICAL_PROCESS_DIED': {
        signatures: [
            'critical process',
            'csrss.exe',
            'smss.exe',
            'wininit.exe',
            'services.exe',
            'lsass.exe'
        ],
        commonCulprits: [
            'System file corruption',
            'Malware infection',
            'Bad Windows update',
            'Driver conflicts',
            'Hardware failure'
        ],
        recommendations: [
            'Boot from Windows installation media and run Startup Repair',
            'Run sfc /scannow from recovery environment',
            'Check for malware in safe mode',
            'Uninstall recent Windows updates',
            'Check hard drive health'
        ]
    },
    
    'WHEA_UNCORRECTABLE_ERROR': {
        signatures: [
            'hardware error',
            'WHEA',
            'Machine Check Exception',
            'CPU error',
            'uncorrectable error'
        ],
        commonCulprits: [
            'CPU hardware failure',
            'Overclocking instability',
            'Power supply issues',
            'Motherboard problems',
            'Overheating'
        ],
        recommendations: [
            'Reset BIOS to default settings',
            'Check CPU temperatures and cooling',
            'Test with different power supply',
            'Run CPU stress test (Prime95)',
            'Check motherboard for bulging capacitors'
        ]
    },
    
    'DRIVER_POWER_STATE_FAILURE': {
        signatures: [
            'power state',
            'driver power',
            'sleep transition',
            'hibernation',
            'S3/S4 state'
        ],
        commonCulprits: [
            'Incompatible drivers',
            'USB device drivers',
            'Network adapter power settings',
            'Graphics driver power management',
            'BIOS power settings'
        ],
        recommendations: [
            'Update all drivers, especially USB and network',
            'Disable fast startup in Windows',
            'Check power settings for devices in Device Manager',
            'Update BIOS for better power management',
            'Disable hibernation temporarily'
        ]
    },
    
    'BAD_POOL_CALLER': {
        signatures: [
            'pool corruption',
            'bad pool',
            'pool header',
            'freed pool',
            'pool allocation'
        ],
        commonCulprits: [
            'Driver memory allocation errors',
            'Antivirus/security software',
            'Virtual machine software',
            'VPN clients',
            'System utilities'
        ],
        recommendations: [
            'Use Driver Verifier with pool tracking',
            'Uninstall third-party antivirus temporarily',
            'Update or remove VPN software',
            'Check for driver updates',
            'Run Windows Memory Diagnostic'
        ]
    },
    
    'FLTMGR_FILE_SYSTEM': {
        signatures: [
            'filter manager',
            'fltmgr',
            'filter context',
            'file system filter',
            'minifilter',
            'bindflt',
            'wcifs',
            'luafv'
        ],
        commonCulprits: [
            'Antivirus filter drivers',
            'Backup software filters',
            'File system virtualization filters',
            'Windows Bind Filter (bindflt.sys)',
            'Encryption software filters',
            'Cloud sync filters'
        ],
        recommendations: [
            'Update or temporarily disable antivirus software',
            'Check for Windows Updates',
            'Disable Windows Container Isolation if not needed',
            'Update backup software to latest version',
            'Run sfc /scannow to repair system files',
            'Check Event Viewer for filter driver errors',
            'Use fltmc.exe to list and manage filter drivers'
        ],
        additionalChecks: [
            'Look for filter driver names in stack trace',
            'Check if parameter 1 is 0x6E (freed context)',
            'Verify filter altitude conflicts'
        ]
    }
};

// Helper function to find matching pattern
export function findMatchingPattern(bugCheckName: string, extractedStrings: string): PatternInfo | null {
    const pattern = KNOWN_PATTERNS[bugCheckName];
    if (!pattern) return null;
    
    // Check if any signatures match in the extracted strings
    const lowerStrings = extractedStrings.toLowerCase();
    const hasMatchingSignature = pattern.signatures.some(sig => 
        lowerStrings.includes(sig.toLowerCase())
    );
    
    return hasMatchingSignature ? pattern : null;
}

// Get enhanced recommendations based on patterns
export function getEnhancedRecommendations(
    bugCheckName: string, 
    culpritDriver: string,
    extractedStrings: string
): string[] {
    const recommendations: string[] = [];
    const pattern = KNOWN_PATTERNS[bugCheckName];
    
    if (pattern) {
        recommendations.push(...pattern.recommendations);
    }
    
    // Add driver-specific recommendations
    if (culpritDriver) {
        const driverLower = culpritDriver.toLowerCase();
        
        if (driverLower.includes('nvlddmkm') || driverLower.includes('nvidia')) {
            recommendations.push(
                'Download latest NVIDIA drivers from nvidia.com',
                'Use DDU (Display Driver Uninstaller) for clean install',
                'Check NVIDIA Control Panel power management settings'
            );
        } else if (driverLower.includes('atikmdag') || driverLower.includes('amd')) {
            recommendations.push(
                'Download latest AMD drivers from amd.com',
                'Use AMD Cleanup Utility before reinstalling',
                'Disable AMD ReLive if not needed'
            );
        } else if (driverLower.includes('intel')) {
            recommendations.push(
                'Update Intel drivers from intel.com',
                'Check for Intel Driver & Support Assistant updates',
                'Verify Intel Management Engine is up to date'
            );
        } else if (driverLower.includes('netio') || driverLower.includes('tcpip')) {
            recommendations.push(
                'Reset Windows network stack: netsh winsock reset',
                'Update network adapter drivers',
                'Disable network adapter power saving'
            );
        }
    }
    
    // Remove duplicates and limit to 10 recommendations
    return [...new Set(recommendations)].slice(0, 10);
}

// Analyze crash context
export function analyzeCrashContext(
    bugCheckCode: number,
    parameters: bigint[],
    extractedStrings: string
): {
    severity: 'low' | 'medium' | 'high' | 'critical';
    category: string;
    urgency: string;
} {
    let severity: 'low' | 'medium' | 'high' | 'critical' = 'medium';
    let category = 'General System Error';
    let urgency = 'Address at your earliest convenience';
    
    // Hardware errors are critical
    if (bugCheckCode === 0x124 || bugCheckCode === 0x9C) {
        severity = 'critical';
        category = 'Hardware Failure';
        urgency = 'Immediate action required - potential hardware damage';
    }
    // Security check failures are high priority
    else if (bugCheckCode === 0x139 || bugCheckCode === 0x109) {
        severity = 'high';
        category = 'Security/Corruption';
        urgency = 'Address promptly - system integrity compromised';
    }
    // Driver issues are medium priority
    else if (bugCheckCode === 0xD1 || bugCheckCode === 0xA || bugCheckCode === 0x9F) {
        severity = 'medium';
        category = 'Driver Issue';
        urgency = 'Address soon - system stability affected';
    }
    // Power/sleep issues are lower priority
    else if (bugCheckCode === 0x9F || bugCheckCode === 0xA0) {
        severity = 'low';
        category = 'Power Management';
        urgency = 'Address when convenient - affects sleep/resume';
    }
    
    // Check for critical system processes
    if (extractedStrings.includes('csrss.exe') || extractedStrings.includes('lsass.exe')) {
        severity = 'critical';
        category = 'Critical System Process';
    }
    
    return { severity, category, urgency };
}
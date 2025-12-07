/**
 * Known Problematic Drivers Database
 * Curated list of drivers with known stability issues, organized by category
 */

export type DriverCategory = 'graphics' | 'audio' | 'network' | 'storage' | 'security' | 'virtualization' | 'other';

export interface ProblematicDriver {
    name: string;                    // Driver filename (e.g., "nvlddmkm.sys")
    displayName: string;             // Human-readable name
    manufacturer: string;
    category: DriverCategory;
    issues: string[];                // Known problems
    commonBugChecks: number[];       // Bug checks commonly caused by this driver
    recommendations: string[];       // Specific fix recommendations
    badVersionPatterns?: string[];   // Version patterns with known issues
    notes?: string;
}

export const PROBLEMATIC_DRIVERS: ProblematicDriver[] = [
    // === GRAPHICS DRIVERS ===
    {
        name: 'nvlddmkm.sys',
        displayName: 'NVIDIA Display Driver',
        manufacturer: 'NVIDIA',
        category: 'graphics',
        issues: [
            'TDR (Timeout Detection and Recovery) failures',
            'DPC watchdog violations during GPU load',
            'Memory management issues with certain driver versions',
            'Power state transition failures'
        ],
        commonBugChecks: [0x116, 0x117, 0x119, 0x133, 0x1A],
        recommendations: [
            'Use DDU (Display Driver Uninstaller) to cleanly remove current drivers',
            'Install the latest NVIDIA Game Ready or Studio driver',
            'If issues persist, try the previous stable driver version',
            'Disable GPU overclocking if enabled',
            'Check GPU temperatures - overheating causes TDR failures'
        ]
    },
    {
        name: 'nvpciflt.sys',
        displayName: 'NVIDIA PCI Filter Driver',
        manufacturer: 'NVIDIA',
        category: 'graphics',
        issues: [
            'PCI bus communication failures',
            'Power management conflicts'
        ],
        commonBugChecks: [0x9F, 0xD1],
        recommendations: [
            'Update to latest NVIDIA driver package',
            'Check motherboard BIOS for PCIe settings updates'
        ]
    },
    {
        name: 'atikmdag.sys',
        displayName: 'AMD/ATI Radeon Display Driver',
        manufacturer: 'AMD',
        category: 'graphics',
        issues: [
            'TDR failures during gaming or video playback',
            'Memory corruption with certain GPU workloads',
            'Driver timeout with multi-monitor setups'
        ],
        commonBugChecks: [0x116, 0x117, 0x3B, 0x1A],
        recommendations: [
            'Use AMD Cleanup Utility before installing new drivers',
            'Install latest AMD Adrenalin driver',
            'Disable Radeon Enhanced Sync if enabled',
            'Try disabling hardware acceleration in browsers'
        ]
    },
    {
        name: 'amdkmdag.sys',
        displayName: 'AMD Kernel Mode Driver',
        manufacturer: 'AMD',
        category: 'graphics',
        issues: [
            'Similar to atikmdag.sys - TDR and memory issues',
            'DirectX 12 compatibility problems with older games'
        ],
        commonBugChecks: [0x116, 0x117, 0x3B],
        recommendations: [
            'Update to latest AMD driver',
            'Check for Windows updates that may conflict',
            'Disable AMD overlay features'
        ]
    },
    {
        name: 'igdkmd64.sys',
        displayName: 'Intel Graphics Kernel Mode Driver',
        manufacturer: 'Intel',
        category: 'graphics',
        issues: [
            'Conflicts with discrete GPU drivers',
            'Display driver crashes during video playback',
            'Issues with hybrid graphics switching'
        ],
        commonBugChecks: [0x116, 0x117, 0x7E],
        recommendations: [
            'Update Intel graphics driver from Intel Download Center',
            'If using hybrid graphics, ensure both drivers are updated',
            'Check BIOS settings for integrated graphics configuration'
        ]
    },

    // === AUDIO DRIVERS ===
    {
        name: 'rtkvhd64.sys',
        displayName: 'Realtek HD Audio Driver',
        manufacturer: 'Realtek',
        category: 'audio',
        issues: [
            'Memory corruption in audio buffer handling',
            'IRQL conflicts with other audio devices',
            'DPC latency spikes causing system instability'
        ],
        commonBugChecks: [0x0A, 0xD1, 0x1A, 0x19],
        recommendations: [
            'Download latest driver from motherboard manufacturer website',
            'Alternatively, use Windows built-in HD Audio driver',
            'Disable audio enhancements in Sound settings'
        ]
    },
    {
        name: 'rtkhdaud.sys',
        displayName: 'Realtek HD Audio (Legacy)',
        manufacturer: 'Realtek',
        category: 'audio',
        issues: [
            'Legacy driver with known stability issues',
            'Conflicts with USB audio devices'
        ],
        commonBugChecks: [0x0A, 0xD1],
        recommendations: [
            'Update to rtkvhd64.sys or use Windows generic driver',
            'Uninstall Realtek Audio Console if causing issues'
        ]
    },
    {
        name: 'nahimicservice.sys',
        displayName: 'Nahimic Audio Service',
        manufacturer: 'A-Volute/SteelSeries',
        category: 'audio',
        issues: [
            'High DPC latency',
            'Conflicts with other audio enhancement software',
            'Memory leaks during extended use'
        ],
        commonBugChecks: [0x133, 0x0A],
        recommendations: [
            'Uninstall Nahimic completely if not needed',
            'Update to latest version from motherboard vendor',
            'Disable Nahimic in BIOS if option available'
        ]
    },

    // === NETWORK DRIVERS ===
    {
        name: 'netwtw06.sys',
        displayName: 'Intel WiFi 6 Driver',
        manufacturer: 'Intel',
        category: 'network',
        issues: [
            'IRQL violations during WiFi scanning',
            'Power state failures when resuming from sleep',
            'Memory corruption with certain access points'
        ],
        commonBugChecks: [0x0A, 0xD1, 0x9F],
        recommendations: [
            'Update to latest Intel WiFi driver from Intel website',
            'Disable power management for WiFi adapter',
            'Try disabling 802.11ax (WiFi 6) mode if issues persist'
        ]
    },
    {
        name: 'netwtw08.sys',
        displayName: 'Intel WiFi 6E Driver',
        manufacturer: 'Intel',
        category: 'network',
        issues: [
            'Similar to netwtw06.sys',
            'Bluetooth coexistence issues'
        ],
        commonBugChecks: [0x0A, 0xD1, 0x9F],
        recommendations: [
            'Update Intel WiFi/Bluetooth drivers together',
            'Disable Bluetooth if not needed'
        ]
    },
    {
        name: 'rt640x64.sys',
        displayName: 'Realtek Ethernet Driver',
        manufacturer: 'Realtek',
        category: 'network',
        issues: [
            'DPC latency issues with certain traffic patterns',
            'Wake-on-LAN configuration bugs'
        ],
        commonBugChecks: [0xD1, 0x0A],
        recommendations: [
            'Update driver from motherboard vendor',
            'Disable Wake-on-LAN in adapter properties'
        ]
    },
    {
        name: 'e1d65x64.sys',
        displayName: 'Intel Gigabit Ethernet Driver',
        manufacturer: 'Intel',
        category: 'network',
        issues: [
            'Rare IRQL issues under heavy network load',
            'Power management conflicts'
        ],
        commonBugChecks: [0xD1],
        recommendations: [
            'Update to latest Intel Ethernet driver',
            'Disable Energy Efficient Ethernet in adapter settings'
        ]
    },

    // === STORAGE DRIVERS ===
    {
        name: 'iaStorAC.sys',
        displayName: 'Intel Rapid Storage Technology Driver',
        manufacturer: 'Intel',
        category: 'storage',
        issues: [
            'Compatibility issues with certain NVMe drives',
            'RAID configuration problems',
            'Delayed write failures'
        ],
        commonBugChecks: [0x7A, 0x77, 0xF4],
        recommendations: [
            'Update Intel RST driver from Intel website',
            'For NVMe drives, consider using Microsoft StorNVMe driver',
            'Check BIOS SATA/RAID mode settings'
        ]
    },
    {
        name: 'iaStorAfs.sys',
        displayName: 'Intel RST Storage Filter',
        manufacturer: 'Intel',
        category: 'storage',
        issues: [
            'Filter driver conflicts with other storage drivers',
            'Optane memory caching issues'
        ],
        commonBugChecks: [0x7A, 0xD1],
        recommendations: [
            'Disable Intel Optane if not using Optane memory',
            'Update RST to latest version or uninstall if not needed'
        ]
    },
    {
        name: 'stornvme.sys',
        displayName: 'Microsoft NVMe Storage Driver',
        manufacturer: 'Microsoft',
        category: 'storage',
        issues: [
            'Generally stable but can have issues with non-compliant NVMe drives',
            'Firmware compatibility problems'
        ],
        commonBugChecks: [0x7A, 0x7E],
        recommendations: [
            'Update NVMe SSD firmware',
            'Check Windows Update for driver updates',
            'Consider using manufacturer-specific NVMe driver'
        ]
    },

    // === SECURITY / ANTIVIRUS DRIVERS ===
    {
        name: 'WdFilter.sys',
        displayName: 'Windows Defender Antimalware Filter',
        manufacturer: 'Microsoft',
        category: 'security',
        issues: [
            'High CPU usage during scans',
            'Conflicts with third-party antivirus',
            'File system filter conflicts'
        ],
        commonBugChecks: [0xC4, 0x19],
        recommendations: [
            'Ensure Windows is fully updated',
            'Add exclusions for high-activity folders',
            'Avoid running multiple antivirus products'
        ]
    },
    {
        name: 'aswSP.sys',
        displayName: 'Avast Self-Protection Module',
        manufacturer: 'Avast/NortonLifeLock',
        category: 'security',
        issues: [
            'Deep system hooks causing instability',
            'Conflicts with Windows Defender',
            'Memory corruption in certain scenarios'
        ],
        commonBugChecks: [0x19, 0x1A, 0xC2],
        recommendations: [
            'Update Avast to latest version',
            'Consider switching to Windows Defender',
            'Use Avast uninstall tool for clean removal'
        ]
    },
    {
        name: 'SymEFASI64.sys',
        displayName: 'Symantec/Norton Extended File Attributes',
        manufacturer: 'NortonLifeLock',
        category: 'security',
        issues: [
            'File system filter conflicts',
            'Boot-time initialization failures',
            'Memory management issues'
        ],
        commonBugChecks: [0x19, 0x7E, 0xF4],
        recommendations: [
            'Use Norton Remove and Reinstall tool',
            'Consider alternative security software',
            'Ensure product is fully updated'
        ]
    },
    {
        name: 'klif.sys',
        displayName: 'Kaspersky Lab Interceptor',
        manufacturer: 'Kaspersky',
        category: 'security',
        issues: [
            'Deep kernel hooks',
            'Conflicts with other security software',
            'Performance impact on system calls'
        ],
        commonBugChecks: [0x19, 0x3B],
        recommendations: [
            'Update to latest Kaspersky version',
            'Use Kaspersky removal tool if switching products',
            'Check for compatibility with other installed software'
        ]
    },
    {
        name: 'mbamswissarmy.sys',
        displayName: 'Malwarebytes Web Protection',
        manufacturer: 'Malwarebytes',
        category: 'security',
        issues: [
            'Network filter conflicts',
            'DPC latency issues'
        ],
        commonBugChecks: [0xD1, 0x0A],
        recommendations: [
            'Update Malwarebytes to latest version',
            'Try disabling Web Protection if issues persist'
        ]
    },

    // === VIRTUALIZATION DRIVERS ===
    {
        name: 'vmswitch.sys',
        displayName: 'Hyper-V Virtual Switch',
        manufacturer: 'Microsoft',
        category: 'virtualization',
        issues: [
            'Network adapter conflicts',
            'IRQL issues with certain physical NICs'
        ],
        commonBugChecks: [0xD1, 0x0A],
        recommendations: [
            'Update network adapter drivers',
            'Check Hyper-V virtual switch configuration',
            'Disable Hyper-V if not needed'
        ]
    },
    {
        name: 'vmmemctl.sys',
        displayName: 'VMware Memory Control',
        manufacturer: 'VMware',
        category: 'virtualization',
        issues: [
            'Memory ballooning conflicts',
            'VM guest crashes during memory pressure'
        ],
        commonBugChecks: [0x1A, 0x50],
        recommendations: [
            'Update VMware Tools to latest version',
            'Adjust VM memory reservation settings'
        ]
    },
    {
        name: 'VBoxDrv.sys',
        displayName: 'VirtualBox Support Driver',
        manufacturer: 'Oracle',
        category: 'virtualization',
        issues: [
            'Kernel mode execution conflicts',
            'Incompatibility with Hyper-V'
        ],
        commonBugChecks: [0x3B, 0x1E],
        recommendations: [
            'Update VirtualBox to latest version',
            'Disable Hyper-V when using VirtualBox',
            'Check BIOS virtualization settings'
        ]
    },

    // === VPN DRIVERS ===
    {
        name: 'wintun.sys',
        displayName: 'WireGuard Tunnel Driver',
        manufacturer: 'WireGuard',
        category: 'network',
        issues: [
            'Occasional IRQL issues during tunnel setup',
            'Conflicts with certain network adapters'
        ],
        commonBugChecks: [0xD1],
        recommendations: [
            'Update WireGuard/VPN client',
            'Try disabling other VPN software'
        ]
    },
    {
        name: 'tap-windows.sys',
        displayName: 'TAP-Windows Adapter (OpenVPN)',
        manufacturer: 'OpenVPN',
        category: 'network',
        issues: [
            'Driver signature issues on newer Windows',
            'Conflicts when multiple VPNs installed'
        ],
        commonBugChecks: [0xD1, 0x0A],
        recommendations: [
            'Update OpenVPN to latest version',
            'Remove old TAP adapter versions',
            'Use WireGuard as alternative if available'
        ]
    },

    // === OTHER COMMON PROBLEMATIC DRIVERS ===
    {
        name: 'AsIO3.sys',
        displayName: 'ASUS I/O Driver',
        manufacturer: 'ASUS',
        category: 'other',
        issues: [
            'Privilege escalation vulnerabilities',
            'Conflicts with game anti-cheat systems',
            'Stack overflow in certain operations'
        ],
        commonBugChecks: [0x1E, 0x3B, 0x139],
        recommendations: [
            'Update ASUS software (Armoury Crate, AI Suite)',
            'Uninstall if not needed for system functionality',
            'Check for BIOS updates'
        ]
    },
    {
        name: 'HWiNFO64A.SYS',
        displayName: 'HWiNFO Kernel Driver',
        manufacturer: 'REALiX',
        category: 'other',
        issues: [
            'Low-level hardware access can conflict with other monitoring',
            'Rare IRQL issues'
        ],
        commonBugChecks: [0xD1],
        recommendations: [
            'Update HWiNFO to latest version',
            'Avoid running multiple hardware monitoring tools'
        ]
    },
    {
        name: 'cpuz.sys',
        displayName: 'CPU-Z Kernel Driver',
        manufacturer: 'CPUID',
        category: 'other',
        issues: [
            'Transient driver loaded on demand',
            'Conflicts with anti-cheat in games'
        ],
        commonBugChecks: [0xD1],
        recommendations: [
            'Update CPU-Z to latest version',
            'Close CPU-Z before running games with anti-cheat'
        ]
    },
    {
        name: 'EasyAntiCheat.sys',
        displayName: 'Easy Anti-Cheat',
        manufacturer: 'Epic Games',
        category: 'security',
        issues: [
            'Kernel-level anti-cheat with deep hooks',
            'Conflicts with debugging/monitoring tools',
            'Issues with certain hardware configurations'
        ],
        commonBugChecks: [0x139, 0x3B],
        recommendations: [
            'Verify game files in game launcher',
            'Reinstall the game if EAC is corrupted',
            'Check for conflicts with RGB/monitoring software'
        ]
    },
    {
        name: 'BEDaisy.sys',
        displayName: 'BattlEye Anti-Cheat',
        manufacturer: 'BattlEye',
        category: 'security',
        issues: [
            'Similar to EAC - kernel-level protection',
            'Conflicts with virtualization software'
        ],
        commonBugChecks: [0x139, 0x3B, 0x1E],
        recommendations: [
            'Update the game using BattlEye',
            'Disable Hyper-V if causing conflicts',
            'Check for software flagged as cheat tools'
        ]
    }
];

/**
 * Find problematic driver info by name
 */
export function findProblematicDriver(driverName: string): ProblematicDriver | undefined {
    const normalizedName = driverName.toLowerCase().replace(/\.sys$/i, '') + '.sys';
    return PROBLEMATIC_DRIVERS.find(d => d.name.toLowerCase() === normalizedName);
}

/**
 * Check if a bug check is commonly caused by a specific driver
 */
export function isDriverAssociatedWithBugCheck(driverName: string, bugCheckCode: number): boolean {
    const driver = findProblematicDriver(driverName);
    return driver?.commonBugChecks.includes(bugCheckCode) ?? false;
}

/**
 * Get all known problematic drivers from a list of module names
 */
export function findProblematicDriversInModules(moduleNames: string[]): ProblematicDriver[] {
    const found: ProblematicDriver[] = [];
    for (const name of moduleNames) {
        const driver = findProblematicDriver(name);
        if (driver) {
            found.push(driver);
        }
    }
    return found;
}

/**
 * Get drivers commonly associated with a specific bug check
 */
export function getDriversForBugCheck(bugCheckCode: number): ProblematicDriver[] {
    return PROBLEMATIC_DRIVERS.filter(d => d.commonBugChecks.includes(bugCheckCode));
}

/**
 * Categorize modules by driver category
 */
export function categorizeModules(moduleNames: string[]): Record<DriverCategory, string[]> {
    const result: Record<DriverCategory, string[]> = {
        graphics: [],
        audio: [],
        network: [],
        storage: [],
        security: [],
        virtualization: [],
        other: []
    };

    for (const name of moduleNames) {
        const driver = findProblematicDriver(name);
        if (driver) {
            result[driver.category].push(name);
        }
    }

    return result;
}

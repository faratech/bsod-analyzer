/**
 * Microsoft Driver Detection
 * Comprehensive list of known Microsoft Windows drivers for third-party detection
 * Used to identify when crashes are likely caused by third-party (non-Microsoft) drivers
 */

// Common Microsoft system drivers
export const MICROSOFT_DRIVERS = new Set([
    // === KERNEL AND CORE ===
    'ntoskrnl.exe',
    'ntkrnlmp.exe',
    'ntkrnlpa.exe',
    'ntkrpamp.exe',
    'hal.dll',
    'halmacpi.dll',
    'halacpi.dll',
    'ci.dll',
    'clfs.sys',
    'tm.sys',

    // === FILE SYSTEMS ===
    'ntfs.sys',
    'fastfat.sys',
    'exfat.sys',
    'refs.sys',
    'cdfs.sys',
    'udfs.sys',
    'mrxsmb.sys',
    'mrxsmb10.sys',
    'mrxsmb20.sys',
    'rdbss.sys',
    'srv.sys',
    'srv2.sys',
    'srvnet.sys',
    'npfs.sys',
    'msfs.sys',

    // === FILTER MANAGER ===
    'fltmgr.sys',
    'fileinfo.sys',
    'wcifs.sys',
    'cldflt.sys',
    'bindflt.sys',
    'filecrypt.sys',
    'luafv.sys',

    // === STORAGE ===
    'storport.sys',
    'storahci.sys',
    'stornvme.sys',
    'disk.sys',
    'partmgr.sys',
    'volmgr.sys',
    'volmgrx.sys',
    'volume.sys',
    'volsnap.sys',
    'fvevol.sys',
    'rdyboost.sys',
    'msahci.sys',
    'ehstorclass.sys',
    'classpnp.sys',
    'scsiport.sys',
    'mpio.sys',
    'iastora.sys',
    'iastorv.sys',
    'spaceport.sys',

    // === NETWORK ===
    'tcpip.sys',
    'tcpip6.sys',
    'fwpkclnt.sys',
    'netio.sys',
    'ndis.sys',
    'ndisuio.sys',
    'ndiswan.sys',
    'nwifi.sys',
    'vwififlt.sys',
    'vwifimp.sys',
    'wfplwf.sys',
    'pacer.sys',
    'netbt.sys',
    'afd.sys',
    'tdx.sys',
    'smb2.sys',
    'mup.sys',
    'dfsc.sys',
    'ipnat.sys',
    'nsiproxy.sys',
    'httpproxy.sys',
    'http.sys',
    'iphlpsvc.dll',
    'bfe.dll',
    'raspptp.sys',
    'rasl2tp.sys',
    'rassstp.sys',
    'raspppoe.sys',
    'ndproxy.sys',
    'ndistapi.sys',
    'ndisimplatform.sys',

    // === GRAPHICS (BASIC MICROSOFT) ===
    'dxgkrnl.sys',
    'dxgmms1.sys',
    'dxgmms2.sys',
    'monitor.sys',
    'basicdisplay.sys',
    'basicrender.sys',
    'win32k.sys',
    'win32kbase.sys',
    'win32kfull.sys',
    'dwm.exe',

    // === USB ===
    'usbhub.sys',
    'usbhub3.sys',
    'usbccgp.sys',
    'usbd.sys',
    'usbport.sys',
    'usbehci.sys',
    'usbuhci.sys',
    'usbohci.sys',
    'usbxhci.sys',
    'ucx01000.sys',
    'usbstor.sys',
    'uaspstor.sys',
    'usbprint.sys',
    'hidusb.sys',

    // === HID ===
    'hidclass.sys',
    'hidparse.sys',
    'kbdclass.sys',
    'kbdhid.sys',
    'mouclass.sys',
    'mouhid.sys',
    'i8042prt.sys',
    'sermouse.sys',

    // === PCI AND BUS ===
    'pci.sys',
    'pcmcia.sys',
    'acpi.sys',
    'acpipagr.sys',
    'acpiex.sys',
    'acpipmi.sys',
    'intelide.sys',
    'pciide.sys',
    'pciidex.sys',
    'msisadrv.sys',
    'isapnp.sys',
    'acpitime.sys',
    'iommu.sys',

    // === POWER MANAGEMENT ===
    'intelppm.sys',
    'amdppm.sys',
    'processr.sys',
    'compbatt.sys',
    'battc.sys',
    'cmbatt.sys',
    'hidbatt.sys',
    'umbus.sys',

    // === SECURITY ===
    'wdfilter.sys',
    'ksecdd.sys',
    'ksecpkg.sys',
    'cng.sys',
    'lsass.exe',
    'lsm.dll',
    'samss.dll',
    'samsrv.dll',
    'secur32.dll',
    'wdigest.dll',
    'kerberos.dll',
    'msv1_0.dll',
    'tspkg.dll',
    'pku2u.dll',
    'cloudap.dll',
    'credssp.dll',

    // === WINDOWS DEFENDER ===
    'wdboot.sys',
    'wdnisdrv.sys',

    // === CRYPTO ===
    'fips.sys',
    'aesni.sys',
    'pku.sys',

    // === VIRTUALIZATION ===
    'vmbus.sys',
    'vmbkmcl.sys',
    'storvsp.sys',
    'vhdmp.sys',
    'vhdparser.sys',
    'hvservice.sys',
    'hvloader.sys',
    'winhv.sys',
    'vmswitch.sys',
    'vmsp.sys',
    'vmms.exe',
    'vmgid.sys',
    'vmprox.sys',
    'vioscsi.sys',
    'viostor.sys',

    // === WDF ===
    'wdf01000.sys',
    'wdfldr.sys',
    'wudfrd.sys',
    'wudfpf.sys',
    'winusb.sys',

    // === AUDIO ===
    'portcls.sys',
    'ks.sys',
    'drmk.sys',
    'mssmbios.sys',
    'hdaudbus.sys',
    'hdaudio.sys',
    'mshdaudio.sys',

    // === PRINT ===
    'spoolsv.exe',
    'localspl.dll',
    'winspool.drv',
    'printfilterpipelinesvc.exe',

    // === SYSTEM PROCESSES ===
    'csrss.exe',
    'smss.exe',
    'wininit.exe',
    'winlogon.exe',
    'services.exe',
    'svchost.exe',
    'system',
    'idle',

    // === MISC KERNEL ===
    'watchdog.sys',
    'wmilib.sys',
    'wdklib.sys',
    'beep.sys',
    'null.sys',
    'vga.sys',
    'videoprt.sys',
    'rdpdr.sys',
    'tdi.sys',
    'mountmgr.sys',
    'ksthunk.sys',
    'swenum.sys',
    'ks.sys',
    'mssmbios.sys',
    'serenum.sys',
    'serial.sys',
    'msrpc.sys',
    'npsvctrig.sys',
    'cimfs.sys',
    'wimmount.sys',

    // === CRASH DUMP ===
    'crashdmp.sys',
    'dumpfve.sys',
    'dumpsata.sys',
    'dumpstorport.sys',

    // === BLUETOOTH ===
    'bthport.sys',
    'bthenum.sys',
    'bthusb.sys',
    'bthpan.sys',
    'rfcomm.sys',
    'bthmodem.sys',
    'bthserv.dll',
    'fsquirt.exe',

    // === WIRELESS ===
    'wlanapi.dll',
    'wlansvc.dll',
    'nativewifi.dll',

    // === SMARTCARD ===
    'winscard.dll',
    'scardssp.dll',
    'scfilter.sys',

    // === TPM ===
    'tpm.sys',
    'tbs.dll',
    'tpmvsc.dll'
]);

// Additional patterns for Microsoft drivers (prefixes)
const MICROSOFT_DRIVER_PREFIXES = [
    'nt',
    'win32',
    'ms',
    'wdf',
    'ndis',
    'usb',
    'hid',
    'stor',
    'vol',
    'disk',
    'pci',
    'acpi',
    'tcp',
    'bth',
    'wlan'
];

// Known third-party driver patterns
const THIRD_PARTY_PATTERNS: { pattern: RegExp; vendor: string }[] = [
    { pattern: /^nv[a-z]+\.sys$/i, vendor: 'NVIDIA' },
    { pattern: /^ati[a-z]+\.sys$/i, vendor: 'AMD/ATI' },
    { pattern: /^amd[a-z]+\.sys$/i, vendor: 'AMD' },
    { pattern: /^intel.*\.sys$/i, vendor: 'Intel' },
    { pattern: /^igfx.*\.sys$/i, vendor: 'Intel Graphics' },
    { pattern: /^rtk?v?hd.*\.sys$/i, vendor: 'Realtek' },
    { pattern: /^rt[0-9]+.*\.sys$/i, vendor: 'Realtek' },
    { pattern: /^rtl.*\.sys$/i, vendor: 'Realtek' },
    { pattern: /^avast.*\.sys$/i, vendor: 'Avast' },
    { pattern: /^asw.*\.sys$/i, vendor: 'Avast' },
    { pattern: /^avg.*\.sys$/i, vendor: 'AVG' },
    { pattern: /^norton.*\.sys$/i, vendor: 'Norton/Symantec' },
    { pattern: /^sym.*\.sys$/i, vendor: 'Symantec' },
    { pattern: /^ccset.*\.sys$/i, vendor: 'Symantec' },
    { pattern: /^klif.*\.sys$/i, vendor: 'Kaspersky' },
    { pattern: /^kl[a-z]+\.sys$/i, vendor: 'Kaspersky' },
    { pattern: /^mbam.*\.sys$/i, vendor: 'Malwarebytes' },
    { pattern: /^vmware.*\.sys$/i, vendor: 'VMware' },
    { pattern: /^vbox.*\.sys$/i, vendor: 'VirtualBox' },
    { pattern: /^tap.*\.sys$/i, vendor: 'VPN (TAP)' },
    { pattern: /^wintun.*\.sys$/i, vendor: 'WireGuard' },
    { pattern: /^asus.*\.sys$/i, vendor: 'ASUS' },
    { pattern: /^asio.*\.sys$/i, vendor: 'ASUS' },
    { pattern: /^hwinfo.*\.sys$/i, vendor: 'HWiNFO' },
    { pattern: /^cpu-?z.*\.sys$/i, vendor: 'CPUID' },
    { pattern: /^easy.*anti.*cheat.*\.sys$/i, vendor: 'Easy Anti-Cheat' },
    { pattern: /^eac.*\.sys$/i, vendor: 'Easy Anti-Cheat' },
    { pattern: /^be.*daisy.*\.sys$/i, vendor: 'BattlEye' },
    { pattern: /^faceit.*\.sys$/i, vendor: 'FACEIT' },
    { pattern: /^corsair.*\.sys$/i, vendor: 'Corsair' },
    { pattern: /^logitech.*\.sys$/i, vendor: 'Logitech' },
    { pattern: /^razer.*\.sys$/i, vendor: 'Razer' },
    { pattern: /^steel.*series.*\.sys$/i, vendor: 'SteelSeries' },
    { pattern: /^nahimic.*\.sys$/i, vendor: 'Nahimic/A-Volute' },
    { pattern: /^sonic.*studio.*\.sys$/i, vendor: 'Sonic Studio' },
];

/**
 * Check if a driver is a known Microsoft driver
 */
export function isMicrosoftDriver(driverName: string): boolean {
    const normalizedName = driverName.toLowerCase();

    // Check exact match
    if (MICROSOFT_DRIVERS.has(normalizedName)) {
        return true;
    }

    // Check if starts with known prefix and ends with .sys or .dll
    if (normalizedName.endsWith('.sys') || normalizedName.endsWith('.dll') || normalizedName.endsWith('.exe')) {
        for (const prefix of MICROSOFT_DRIVER_PREFIXES) {
            if (normalizedName.startsWith(prefix)) {
                // Additional validation - many MS drivers have specific patterns
                // This is a heuristic and may need refinement
                return true;
            }
        }
    }

    return false;
}

/**
 * Check if a driver is a third-party (non-Microsoft) driver
 */
export function isThirdPartyDriver(driverName: string): boolean {
    return !isMicrosoftDriver(driverName);
}

/**
 * Try to identify the vendor of a third-party driver
 */
export function identifyVendor(driverName: string): string | undefined {
    const normalizedName = driverName.toLowerCase();

    for (const { pattern, vendor } of THIRD_PARTY_PATTERNS) {
        if (pattern.test(normalizedName)) {
            return vendor;
        }
    }

    return undefined;
}

/**
 * Categorize a list of drivers into Microsoft and third-party
 */
export function categorizeDrivers(driverNames: string[]): {
    microsoft: string[];
    thirdParty: { name: string; vendor?: string }[];
} {
    const microsoft: string[] = [];
    const thirdParty: { name: string; vendor?: string }[] = [];

    for (const name of driverNames) {
        if (isMicrosoftDriver(name)) {
            microsoft.push(name);
        } else {
            thirdParty.push({
                name,
                vendor: identifyVendor(name)
            });
        }
    }

    return { microsoft, thirdParty };
}

/**
 * Get suspicion score for a driver
 * Higher score = more likely to be the culprit
 */
export function getDriverSuspicionScore(
    driverName: string,
    isAtExceptionAddress: boolean,
    _bugCheckCode?: number // Reserved for future bug-check-specific scoring
): number {
    let score = 0;

    // Exception address is the strongest signal
    if (isAtExceptionAddress) {
        score += 100;
    }

    // Third-party drivers are more suspicious
    if (isThirdPartyDriver(driverName)) {
        score += 25;
    }

    // Known vendor patterns get slight adjustment
    const vendor = identifyVendor(driverName);
    if (vendor) {
        // Known third-party vendors are slightly more suspicious
        // because we can identify them, meaning they're common
        score += 5;
    }

    // Some Microsoft drivers are "wrapper" drivers and often blamed incorrectly
    const lowerName = driverName.toLowerCase();
    if (['ntoskrnl.exe', 'ntkrnlmp.exe', 'win32k.sys', 'dxgkrnl.sys'].includes(lowerName)) {
        // These are often in the stack but rarely the actual cause
        score -= 20;
    }

    return score;
}

/**
 * Filter and rank suspect drivers from a list
 */
export function rankSuspectDrivers(
    moduleNames: string[],
    culpritFromExceptionAddress?: string,
    bugCheckCode?: number
): { driver: string; score: number; vendor?: string; isMicrosoft: boolean }[] {
    const ranked = moduleNames.map(name => ({
        driver: name,
        score: getDriverSuspicionScore(
            name,
            name.toLowerCase() === culpritFromExceptionAddress?.toLowerCase(),
            bugCheckCode
        ),
        vendor: identifyVendor(name),
        isMicrosoft: isMicrosoftDriver(name)
    }));

    // Sort by score descending
    ranked.sort((a, b) => b.score - a.score);

    return ranked;
}

/**
 * Get the most likely culprit from a list of modules
 * Returns undefined if no clear culprit can be identified
 */
export function identifyLikelyCulprit(
    moduleNames: string[],
    exceptionAddress?: bigint,
    moduleAddresses?: { name: string; base: bigint; size: number }[]
): { driver: string; confidence: 'high' | 'medium' | 'low'; reason: string } | undefined {
    // If we have exception address and module mapping, check which module contains it
    if (exceptionAddress !== undefined && moduleAddresses && moduleAddresses.length > 0) {
        for (const mod of moduleAddresses) {
            const end = mod.base + BigInt(mod.size);
            if (exceptionAddress >= mod.base && exceptionAddress < end) {
                const isThirdParty = isThirdPartyDriver(mod.name);
                return {
                    driver: mod.name,
                    confidence: 'high',
                    reason: `Exception occurred at address 0x${exceptionAddress.toString(16)} which is inside ${mod.name}${isThirdParty ? ' (third-party driver)' : ''}`
                };
            }
        }
    }

    // Look for third-party drivers in the module list
    const thirdPartyDrivers = moduleNames.filter(isThirdPartyDriver);

    if (thirdPartyDrivers.length === 1) {
        return {
            driver: thirdPartyDrivers[0],
            confidence: 'medium',
            reason: `Only third-party driver loaded: ${thirdPartyDrivers[0]}`
        };
    }

    if (thirdPartyDrivers.length > 0) {
        // Return the first one, but with low confidence
        const vendor = identifyVendor(thirdPartyDrivers[0]);
        return {
            driver: thirdPartyDrivers[0],
            confidence: 'low',
            reason: `Multiple third-party drivers present. ${thirdPartyDrivers[0]}${vendor ? ` (${vendor})` : ''} is a possible suspect`
        };
    }

    return undefined;
}

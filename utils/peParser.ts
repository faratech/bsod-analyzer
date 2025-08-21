/**
 * PE (Portable Executable) parser for extracting driver versions and signatures
 */

interface PEHeader {
    signature: number;
    machine: number;
    numberOfSections: number;
    timeDateStamp: number;
    sizeOfOptionalHeader: number;
    characteristics: number;
}

interface OptionalHeader {
    magic: number;
    majorLinkerVersion: number;
    minorLinkerVersion: number;
    sizeOfCode: number;
    addressOfEntryPoint: number;
    imageBase: bigint;
    sectionAlignment: number;
    fileAlignment: number;
    majorOperatingSystemVersion: number;
    minorOperatingSystemVersion: number;
    majorImageVersion: number;
    minorImageVersion: number;
    sizeOfImage: number;
    sizeOfHeaders: number;
    checkSum: number;
}

interface VersionInfo {
    fileVersion: string;
    productVersion: string;
    companyName?: string;
    fileDescription?: string;
    originalFilename?: string;
    internalName?: string;
}

interface CertificateInfo {
    signed: boolean;
    signerName?: string;
    issuer?: string;
    validFrom?: Date;
    validTo?: Date;
    trusted?: boolean;
}

export class PEParser {
    private view: DataView;
    private buffer: ArrayBuffer;
    
    constructor(buffer: ArrayBuffer) {
        this.buffer = buffer;
        this.view = new DataView(buffer);
    }
    
    /**
     * Parse PE headers and extract version information
     */
    public parseDriverInfo(offset: number): { version?: VersionInfo; certificate?: CertificateInfo } | null {
        try {
            // Check DOS header
            if (this.view.getUint16(offset, true) !== 0x5A4D) { // 'MZ'
                return null;
            }
            
            // Get PE header offset
            const peOffset = this.view.getUint32(offset + 0x3C, true);
            if (offset + peOffset + 4 > this.buffer.byteLength) {
                return null;
            }
            
            // Check PE signature
            if (this.view.getUint32(offset + peOffset, true) !== 0x00004550) { // 'PE\0\0'
                return null;
            }
            
            // Parse PE header
            const peHeader = this.parsePEHeader(offset + peOffset + 4);
            if (!peHeader) return null;
            
            // Parse optional header
            const optionalHeader = this.parseOptionalHeader(offset + peOffset + 24);
            if (!optionalHeader) return null;
            
            // Find resource section
            const resourceSection = this.findResourceSection(offset + peOffset + 24 + peHeader.sizeOfOptionalHeader, peHeader.numberOfSections);
            
            let versionInfo: VersionInfo | undefined;
            if (resourceSection) {
                versionInfo = this.extractVersionInfo(offset + resourceSection.virtualAddress);
            }
            
            // Check for certificate (Authenticode)
            const certificateInfo = this.checkCertificate(offset, optionalHeader);
            
            return {
                version: versionInfo,
                certificate: certificateInfo
            };
            
        } catch (error) {
            console.error('PE parsing error:', error);
            return null;
        }
    }
    
    private parsePEHeader(offset: number): PEHeader | null {
        if (offset + 20 > this.buffer.byteLength) return null;
        
        return {
            machine: this.view.getUint16(offset, true),
            numberOfSections: this.view.getUint16(offset + 2, true),
            timeDateStamp: this.view.getUint32(offset + 4, true),
            sizeOfOptionalHeader: this.view.getUint16(offset + 16, true),
            characteristics: this.view.getUint16(offset + 18, true),
            signature: 0x4550
        };
    }
    
    private parseOptionalHeader(offset: number): OptionalHeader | null {
        if (offset + 96 > this.buffer.byteLength) return null;
        
        const magic = this.view.getUint16(offset, true);
        const is64Bit = magic === 0x20B;
        
        return {
            magic,
            majorLinkerVersion: this.view.getUint8(offset + 2),
            minorLinkerVersion: this.view.getUint8(offset + 3),
            sizeOfCode: this.view.getUint32(offset + 4, true),
            addressOfEntryPoint: this.view.getUint32(offset + 16, true),
            imageBase: is64Bit ? this.view.getBigUint64(offset + 24, true) : BigInt(this.view.getUint32(offset + 28, true)),
            sectionAlignment: this.view.getUint32(offset + 32, true),
            fileAlignment: this.view.getUint32(offset + 36, true),
            majorOperatingSystemVersion: this.view.getUint16(offset + 40, true),
            minorOperatingSystemVersion: this.view.getUint16(offset + 42, true),
            majorImageVersion: this.view.getUint16(offset + 44, true),
            minorImageVersion: this.view.getUint16(offset + 46, true),
            sizeOfImage: this.view.getUint32(offset + 56, true),
            sizeOfHeaders: this.view.getUint32(offset + 60, true),
            checkSum: this.view.getUint32(offset + 64, true),
        };
    }
    
    private findResourceSection(offset: number, numberOfSections: number): { virtualAddress: number; size: number } | null {
        // Parse section headers to find .rsrc
        for (let i = 0; i < numberOfSections; i++) {
            const sectionOffset = offset + (i * 40);
            if (sectionOffset + 40 > this.buffer.byteLength) break;
            
            // Read section name
            const nameBytes = new Uint8Array(this.buffer, sectionOffset, 8);
            const name = String.fromCharCode(...nameBytes).replace(/\0/g, '');
            
            if (name.startsWith('.rsrc')) {
                return {
                    virtualAddress: this.view.getUint32(sectionOffset + 12, true),
                    size: this.view.getUint32(sectionOffset + 16, true)
                };
            }
        }
        
        return null;
    }
    
    private extractVersionInfo(resourceOffset: number): VersionInfo | undefined {
        // Simplified version extraction
        // In reality, this requires parsing the VERSION resource tree
        
        // Search for version patterns
        const searchRange = Math.min(0x10000, this.buffer.byteLength - resourceOffset);
        const data = new Uint8Array(this.buffer, resourceOffset, searchRange);
        
        // Look for VS_VERSION_INFO signature
        const signature = [0x56, 0x00, 0x53, 0x00, 0x5F, 0x00, 0x56, 0x00]; // V.S._.V.
        
        for (let i = 0; i < data.length - 100; i++) {
            let found = true;
            for (let j = 0; j < signature.length; j++) {
                if (data[i + j] !== signature[j]) {
                    found = false;
                    break;
                }
            }
            
            if (found) {
                // Found VS_VERSION_INFO
                // Extract file version (simplified)
                const versionOffset = i + 0x30; // Approximate offset to version data
                if (versionOffset + 16 < data.length) {
                    const fileVersionMS = this.view.getUint32(resourceOffset + versionOffset, true);
                    const fileVersionLS = this.view.getUint32(resourceOffset + versionOffset + 4, true);
                    
                    const major = (fileVersionMS >> 16) & 0xFFFF;
                    const minor = fileVersionMS & 0xFFFF;
                    const build = (fileVersionLS >> 16) & 0xFFFF;
                    const revision = fileVersionLS & 0xFFFF;
                    
                    return {
                        fileVersion: `${major}.${minor}.${build}.${revision}`,
                        productVersion: `${major}.${minor}.${build}.${revision}`,
                        // Additional string info would require more parsing
                    };
                }
            }
        }
        
        return undefined;
    }
    
    private checkCertificate(baseOffset: number, optionalHeader: OptionalHeader): CertificateInfo {
        // Check if certificate table exists in data directories
        // This is a simplified check - real implementation would parse the certificate
        
        return {
            signed: false, // Would need to check certificate table
            // Additional certificate info would require parsing PKCS#7 data
        };
    }
}

/**
 * Extract driver versions from a memory dump
 */
export function extractDriverVersions(buffer: ArrayBuffer, modules: Array<{ name: string; baseAddress: bigint; sizeOfImage: number }>): Map<string, VersionInfo> {
    const versions = new Map<string, VersionInfo>();
    const parser = new PEParser(buffer);
    
    for (const module of modules) {
        // Convert virtual address to file offset (simplified)
        const offset = Number(module.baseAddress % BigInt(buffer.byteLength));
        
        const info = parser.parseDriverInfo(offset);
        if (info?.version) {
            versions.set(module.name, info.version);
        }
    }
    
    return versions;
}

/**
 * Identify outdated drivers based on version info
 */
export function identifyOutdatedDrivers(versions: Map<string, VersionInfo>): Array<{ name: string; version: string; status: string }> {
    const outdated: Array<{ name: string; version: string; status: string }> = [];
    
    // Known problematic driver versions
    const problematicDrivers: Record<string, { minVersion: string; issue: string }> = {
        'nvlddmkm.sys': { minVersion: '31.0.15.2649', issue: 'Known stability issues in older versions' },
        'atikmdag.sys': { minVersion: '31.0.12029.10015', issue: 'Memory leak in older versions' },
        'intelppm.sys': { minVersion: '10.0.19041.1', issue: 'Power management issues' },
        'tcpip.sys': { minVersion: '10.0.19041.2486', issue: 'Network stability fixes needed' },
    };
    
    for (const [name, version] of versions) {
        const lowerName = name.toLowerCase();
        if (problematicDrivers[lowerName]) {
            const problem = problematicDrivers[lowerName];
            if (compareVersions(version.fileVersion, problem.minVersion) < 0) {
                outdated.push({
                    name,
                    version: version.fileVersion,
                    status: `Outdated - ${problem.issue}`
                });
            }
        }
    }
    
    return outdated;
}

/**
 * Compare version strings (returns -1 if v1 < v2, 0 if equal, 1 if v1 > v2)
 */
function compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        
        if (p1 < p2) return -1;
        if (p1 > p2) return 1;
    }
    
    return 0;
}
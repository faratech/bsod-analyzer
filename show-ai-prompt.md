# What Information is Sent to the AI for BSOD Analysis

Based on the improvements made, here's exactly what information the AI receives for analysis:

## 1. **Crash Context**
```
**File:** example.dmp (minidump/kernel dump, size in bytes)
**Bug Check:** 0x0000007E (SYSTEM_THREAD_EXCEPTION_NOT_HANDLED)
**Windows Version:** Windows 10/11
**Crash Time:** 2024-01-15 14:32:45 UTC
**CPU:** Intel(R) Core(TM) i7-9700K @ 3.60GHz
**Memory:** 16 GB
```

## 2. **Structured Dump Analysis**
```
Dump Header:
- Signature: MDMP
- Version: 15.7601
- Machine Type: 0x8664 (x64)

Bug Check Information:
- Code: 0x0000007E (SYSTEM_THREAD_EXCEPTION_NOT_HANDLED)
- Parameter 1: 0xffffffffc0000005
- Parameter 2: 0xfffff80234567890
- Parameter 3: 0xfffffa8012345678
- Parameter 4: 0xfffffa8087654321

Parameter Validation:
- Valid: YES
- Parameter Meanings:
  - Arg1: Exception code (0xc0000005 = Access Violation)
  - Arg2: Address where exception occurred (likely in driver)
  - Arg3: Exception parameter 0
  - Arg4: Exception parameter 1

Bug Check Analysis:
- Severity: CRITICAL
- Analysis: Unhandled kernel exception, likely driver fault
- Likely Causes: Faulty driver, memory corruption, hardware issue
```

## 3. **Exception Information**
```
Exception Information:
- Code: 0xC0000005 (Access violation)
- Faulting Address: 0xfffff80234567890
- Parameter 1: 0x0 (attempted to read)
- Parameter 2: 0x0 (NULL pointer dereference)
```

## 4. **Thread Context**
```
Thread Context:
- RIP (Instruction Pointer): 0xfffff80234567890
- RSP (Stack Pointer): 0xfffffa8012345000
- RBP (Base Pointer): 0xfffffa8012345100
```

## 5. **Detected Drivers**
```
**Detected Drivers (30 found):**
- nvlddmkm.sys (Graphics (NVIDIA))
- ntoskrnl.exe (Windows Kernel)
- hal.dll (Hardware Abstraction Layer)
- tcpip.sys (Network)
- ndis.sys (Network)
- atikmdag.sys (Graphics (AMD))
- intelppm.sys (Intel Device)
```

## 6. **Module List from Dump**
```
**Module List from Dump:**
- ntoskrnl.exe (Size: 7405568 bytes) [Timestamp: 2024-01-10T10:30:00Z]
- hal.dll (Size: 533504 bytes) [Timestamp: 2024-01-10T10:30:00Z]
- nvlddmkm.sys (Size: 18669568 bytes) [Timestamp: 2023-12-15T08:45:00Z]
```

## 7. **Advanced Analysis**

### Exception Analysis
```
**Exception Analysis (3 found):**
- c0000005 at 0xfffff80234567890
- 80000003 at 0xfffff80234567000 (Breakpoint)
```

### Memory Corruption Detection
```
**Memory Corruption Detection:**
- USE_AFTER_FREE: Found 64 bytes of freed memory pattern 0xFEEEFEEE (confidence: 85%)
- HEAP_CORRUPTION: Heap block size mismatch: 256 vs 512 (confidence: 75%)
- STACK_CORRUPTION: Broken stack frame chain detected (confidence: 65%)
```

### Driver Signatures
```
**Driver Signatures (15 found):**
- nvlddmkm.sys (Base: 0xfffff880012340000, Size: 18669568, Unsigned)
- customdriver.sys (Base: 0xfffff880045670000, Size: 65536, Unsigned)
```

### Pool Corruption
```
**Pool Corruption:**
Found 2 corrupted pool headers
```

### IRQL Violations
```
**IRQL Violations:**
- IRQL raised to DISPATCH_LEVEL without lowering at 0xfffff80234567890
```

### Memory Pattern Analysis
```
**Memory Pattern Analysis:**
Critical: Found 2 high-confidence corruption indicators.
- USE_AFTER_FREE: Found 256 bytes of freed memory pattern 0xFEEEFEEE (confidence: 90%)
- NULL pointer dereference instruction at offset 0x1234
```

### Outdated Driver Detection
```
**Outdated Driver Detection:**
- nvlddmkm.sys version 31.0.15.2000: Outdated - Known stability issues in older versions
- intelppm.sys version 10.0.19041.0: Outdated - Power management issues
```

## 8. **Stack Trace**
```
**Stack Trace (15 frames extracted):**
00: nt!KeBugCheckEx
01: nt!KiPageFault+0x260
02: nvlddmkm!nvDumpConfig+0x43890
03: nvlddmkm!nvDumpConfig+0x43cd0
04: dxgkrnl!DpiUpdateProcessNotification+0x1a0
05: nt!KiSystemServiceCopyEnd+0x13
06: nt!KiCallUserMode+0x0
07: 0xfffffa8012345678
```

## 9. **Binary Dump Analysis**
The AI receives the first 2048 bytes of the dump in hexadecimal format for pattern analysis.

## 10. **Extracted String Data**
The AI receives up to 32KB of extracted readable strings from the dump, which includes:
- Error messages
- Driver names
- Function names
- File paths
- Registry keys
- System configuration

## 11. **Real WinDbg Command Output**
When using advanced analysis tools, the AI now receives actual command output:

### !analyze -v
```
*******************************************************************************
*                        Bugcheck Analysis                                    *
*******************************************************************************

BUGCHECK_CODE: 0000007e

Arguments:
Arg1: ffffffffc0000005
Arg2: fffff80234567890
Arg3: fffffa8012345678
Arg4: fffffa8087654321

EXCEPTION_CODE: (NTSTATUS) 0xc0000005 - Access violation
FAULTING_IP: fffff80234567890

PROCESS_NAME:  System

MODULE_NAME: nvlddmkm
IMAGE_NAME:  nvlddmkm.sys

STACK_TEXT:
00 fffffa8012345000 fffff80234567890 nvlddmkm+0x43890
01 fffffa8012345100 fffff80234567cd0 nvlddmkm+0x43cd0
...
```

### lm kv
```
start             end                 module name
fffff880`01234000 fffff880`02345000   nvlddmkm   (deferred)
    Image path: nvlddmkm.sys
    Image name: nvlddmkm.sys
    Timestamp:  2023-12-15
    CheckSum:   00123456
    ImageSize:  01111000
```

## Key Improvements in Data Quality

1. **Real Data vs Simulated**: WinDbg commands now parse actual dump data instead of AI simulation
2. **Multiple Stack Extraction Methods**: Uses 4 different strategies to ensure stack traces are found
3. **Memory Corruption Detection**: Identifies specific patterns like use-after-free, buffer overflows
4. **Driver Version Checking**: Automatically identifies outdated drivers with known issues
5. **Comprehensive Pattern Matching**: Enhanced regex patterns catch more function names and symbols
6. **Binary Analysis**: Scans for kernel addresses and RSDS debug information
7. **Confidence Scores**: Memory corruption indicators include confidence percentages

This comprehensive data allows the AI to provide much more accurate and specific analysis, identifying the actual cause of crashes rather than making educated guesses.
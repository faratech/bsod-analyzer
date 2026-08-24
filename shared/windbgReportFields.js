import { extractFullAnalyzeOutput } from './windbgApiClient.js';
import { extractWinDbgWindowsVersion } from './windowsVersion.js';

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function compactWindowsBuild(version) {
  const text = stringValue(version);
  if (!text) return undefined;
  const match = /^10\.0\.(\d{5}\.\d+)$/i.exec(text);
  return match ? match[1] : text;
}

function normalizeBugCheckParameterValues(parameters) {
  return Array.isArray(parameters)
    ? parameters
      .filter(value => typeof value === 'string' && value.trim().length > 0)
      .map(value => value.trim())
    : [];
}

function parseHexBigInt(value) {
  const hex = String(value || '').replace(/^0x/i, '').replace(/`/g, '').trim();
  return /^[0-9a-f]+$/i.test(hex) ? BigInt(`0x${hex}`) : 0n;
}

function setString(result, key, value) {
  const text = stringValue(value);
  if (text) result[key] = text;
  return text;
}

function mapStructuredSignalToReport(structured, options = {}) {
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return {};

  const bugcheck = structured.bugcheck && typeof structured.bugcheck === 'object'
    ? structured.bugcheck
    : {};
  const crash = structured.crash && typeof structured.crash === 'object'
    ? structured.crash
    : {};
  const target = structured.target && typeof structured.target === 'object'
    ? structured.target
    : {};
  const process = structured.process && typeof structured.process === 'object'
    ? structured.process
    : {};
  const execution = structured.execution && typeof structured.execution === 'object'
    ? structured.execution
    : {};

  const result = {};
  const bugCode = stringValue(bugcheck.code);
  const bugName = stringValue(bugcheck.name);
  const parameters = normalizeBugCheckParameterValues(bugcheck.parameters);
  if (bugCode || bugName || parameters.length > 0) {
    const numericBugCode = Number.parseInt((bugCode || '').replace(/^0x/i, ''), 16) || 0;
    result.bugCheck = {
      code: bugCode || 'Unknown',
      name: bugName || 'UNKNOWN',
      parameters: parameters.map((value, index) => {
        let meaning;
        if (typeof options.explainBugCheckParameter === 'function') {
          try {
            meaning = options.explainBugCheckParameter(
              numericBugCode,
              index + 1,
              parseHexBigInt(value)
            );
          } catch {
            meaning = undefined;
          }
        }
        return {
          value,
          meaning: stringValue(meaning) || `Bug check parameter ${index + 1}`
        };
      })
    };
  }

  setString(result, 'failureBucketId', crash.failureBucketId);
  setString(result, 'symbolName', crash.symbolName);
  setString(result, 'moduleName', crash.moduleName);
  setString(result, 'imageName', crash.imageName);
  if (setString(result, 'imageVersion', crash.imageVersion)) {
    result.imageBuild = compactWindowsBuild(result.imageVersion);
  }
  setString(result, 'faultAddress', crash.readAddress || crash.writeAddress || crash.faultAddress);

  const systemInfo = {};
  setString(systemInfo, 'windowsVersion', target.os_version || target.osVersion);
  setString(systemInfo, 'systemUptime', target.system_uptime || target.systemUptime);
  setString(systemInfo, 'processName', crash.processName || process.name || process.imageName);
  if (result.imageName && /^nt(?:krnlmp|oskrnl)\.exe$/i.test(result.imageName) && result.imageVersion) {
    systemInfo.kernelImageVersion = result.imageVersion;
    systemInfo.kernelBuild = compactWindowsBuild(result.imageVersion);
  }

  if (structured.registers && typeof structured.registers === 'object' && !Array.isArray(structured.registers)) {
    result.registers = { ...structured.registers };
  }

  if (Array.isArray(structured.stackFrames)) {
    result.callStack = structured.stackFrames
      .filter(frame => frame && typeof frame === 'object' && !Array.isArray(frame))
      .map(frame => {
        const symbol = stringValue(frame.symbol)?.replace(/^:\s*/, '');
        const match = symbol?.match(/^([^!]+)!([^+]+)(?:\+(.+))?$/);
        return {
          address: stringValue(frame.sp) || stringValue(frame.ret_addr) || stringValue(frame.address) || 'unknown',
          module: stringValue(match?.[1]) || stringValue(frame.module) || 'unknown',
          function: stringValue(match?.[2]) || stringValue(frame.function),
          offset: stringValue(match?.[3]) || stringValue(frame.offset)
        };
      })
      .slice(0, 20);
  }

  if (Array.isArray(structured.notableModules)) {
    result.loadedModules = structured.notableModules
      .filter(module => module && typeof module === 'object' && !Array.isArray(module))
      .map(module => {
        const details = module.details && typeof module.details === 'object' && !Array.isArray(module.details)
          ? module.details
          : {};
        const name = stringValue(module.name) || stringValue(details.imageName) || 'unknown';
        const imageName = stringValue(details.imageName);
        const version = stringValue(details.fileVersion) || stringValue(details.productVersion);
        if (/^nt(?:krnlmp|oskrnl)?$/i.test(name) && imageName && /^nt(?:krnlmp|oskrnl)\.exe$/i.test(imageName) && version) {
          systemInfo.kernelImageVersion = version;
          systemInfo.kernelBuild = compactWindowsBuild(version);
          result.imageName ||= imageName;
          result.imageVersion ||= version;
          result.imageBuild ||= compactWindowsBuild(version);
        }
        return {
          name,
          base: stringValue(module.base),
          version,
          timestamp: stringValue(details.timestamp),
          isCulprit: name.toLowerCase() === stringValue(result.moduleName)?.toLowerCase()
        };
      })
      .slice(0, 30);
  }

  if (Object.keys(systemInfo).length > 0) result.systemInfo = systemInfo;
  if (execution.timedOut === true) {
    result.summary = 'WinDbg analysis timed out before all evidence could be collected.';
  }

  return result;
}

function extractVersionFromModuleBlock(block) {
  const patterns = [
    /^\s*File version:\s*(10\.0\.\d{5}\.\d+)\b/im,
    /^\s*ProductVersion:\s*(10\.0\.\d{5}\.\d+)\b/im,
    /^\s*FileVersion:\s*(10\.0\.\d{5}\.\d+)\b/im,
    /^\s*IMAGE_VERSION:\s*(10\.0\.\d{5}\.\d+)\b/im
  ];
  for (const pattern of patterns) {
    const match = block.match(pattern);
    if (match) return match[1];
  }
  return undefined;
}

function extractKernelImageVersion(output) {
  const blocks = output.split(/(?=^[0-9a-f`]+\s+[0-9a-f`]+\s+\S+\s)/gim);
  for (const block of blocks) {
    if (!/^[0-9a-f`]+\s+[0-9a-f`]+\s+(?:nt|ntkrnlmp|ntoskrnl)\s/im.test(block)) continue;
    if (!/\b(?:Loaded symbol image file|Image name):\s+nt(?:krnlmp|oskrnl)\.exe\b/i.test(block)) continue;
    const version = extractVersionFromModuleBlock(block);
    if (version) return version;
  }

  const imageName = output.match(/^\s*IMAGE_NAME:\s*(\S+)/im)?.[1];
  if (imageName && /^nt(?:krnlmp|oskrnl)\.exe$/i.test(imageName)) {
    return output.match(/^\s*IMAGE_VERSION:\s*(10\.0\.\d{5}\.\d+)\b/im)?.[1];
  }
  return undefined;
}

function parseStackText(stackText) {
  const frames = [];
  for (const line of String(stackText || '').split('\n')) {
    const match = line.match(/^\s*([0-9a-fA-F`]+)\s+(\S+?)!([^+\s]+)(?:\+0x([0-9a-fA-F]+))?/);
    if (match) {
      frames.push({
        address: match[1],
        module: match[2],
        function: match[3],
        offset: match[4] ? `0x${match[4]}` : undefined
      });
    } else {
      const addressMatch = line.match(/^\s*([0-9a-fA-F`]{16,17})\s+([0-9a-fA-F`]+)/);
      if (addressMatch && !line.includes('Args to Child')) {
        frames.push({ address: addressMatch[1], module: 'unknown', function: undefined, offset: undefined });
      }
    }
    if (frames.length >= 20) break;
  }
  return frames;
}

function parseWinDbgOutput(output) {
  if (typeof output !== 'string' || !output) return {};
  const result = {};

  setString(result, 'failureBucketId', output.match(/FAILURE_BUCKET_ID:\s*(.+)/i)?.[1]);
  setString(result, 'symbolName', output.match(/SYMBOL_NAME:\s*(.+)/i)?.[1]);
  setString(result, 'moduleName', output.match(/MODULE_NAME:\s*(\S+)/i)?.[1]);
  setString(result, 'imageName', output.match(/IMAGE_NAME:\s*(\S+)/i)?.[1]);
  if (setString(result, 'imageVersion', output.match(/IMAGE_VERSION:\s*(.+)/i)?.[1])) {
    result.imageBuild = compactWindowsBuild(result.imageVersion);
  }

  const faultAddress = output.match(/TRAP_FRAME:.*Rip\s*=\s*([0-9a-fA-F`]+)/i)
    || output.match(/FAULTING_IP:\s*\S+\s*([0-9a-fA-F`]+)/i)
    || output.match(/READ_ADDRESS:\s*([0-9a-fA-F`]+)/i)
    || output.match(/WRITE_ADDRESS:\s*([0-9a-fA-F`]+)/i);
  setString(result, 'faultAddress', faultAddress?.[1]);

  const systemInfo = {};
  setString(systemInfo, 'processName', output.match(/PROCESS_NAME:\s*(\S+)/i)?.[1]);
  setString(systemInfo, 'windowsVersion', extractWinDbgWindowsVersion(output));
  const kernelImageVersion = extractKernelImageVersion(output);
  if (kernelImageVersion) {
    systemInfo.kernelImageVersion = kernelImageVersion;
    systemInfo.kernelBuild = compactWindowsBuild(kernelImageVersion);
  } else if (result.imageName && /^nt(?:krnlmp|oskrnl)\.exe$/i.test(result.imageName) && result.imageVersion) {
    systemInfo.kernelImageVersion = result.imageVersion;
    systemInfo.kernelBuild = compactWindowsBuild(result.imageVersion);
  }
  setString(systemInfo, 'systemUptime', output.match(/SYSTEM_UPTIME:\s*(.+)/i)?.[1]);
  if (Object.keys(systemInfo).length > 0) result.systemInfo = systemInfo;

  const stackMatch = output.match(/STACK_TEXT:\s*([\s\S]*?)(?=\n\n[A-Z_]+:|CHKIMG_EXTENSION|SYMBOL_NAME|\n\nFOLLOWUP|$)/i);
  if (stackMatch) result.callStack = parseStackText(stackMatch[1]);

  result.rawWinDbgOutput = extractFullAnalyzeOutput(output) || output;
  return result;
}

function mergeReportWithWinDbgFields(report, structuredFields = {}, parsedFields = {}) {
  const merged = {
    ...(report && typeof report === 'object' && !Array.isArray(report) ? report : {}),
    ...(structuredFields && typeof structuredFields === 'object' ? structuredFields : {}),
    ...(parsedFields && typeof parsedFields === 'object' ? parsedFields : {})
  };
  const systemInfo = {
    ...(report?.systemInfo && typeof report.systemInfo === 'object' ? report.systemInfo : {}),
    ...(structuredFields?.systemInfo && typeof structuredFields.systemInfo === 'object' ? structuredFields.systemInfo : {}),
    ...(parsedFields?.systemInfo && typeof parsedFields.systemInfo === 'object' ? parsedFields.systemInfo : {})
  };
  if (Object.keys(systemInfo).length > 0) merged.systemInfo = systemInfo;
  else delete merged.systemInfo;
  return merged;
}

export {
  compactWindowsBuild,
  mapStructuredSignalToReport,
  mergeReportWithWinDbgFields,
  parseStackText,
  parseWinDbgOutput
};

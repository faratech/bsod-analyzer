import {
  generateForumReport as generateForumReportImpl,
  generateMarkdownReport as generateMarkdownReportImpl,
  getReportFacts as getReportFactsImpl,
  redactPublicReportText as redactPublicReportTextImpl,
} from '../shared/reportFacts.js';
import type { DumpFile } from '../types';

export type EvidenceSource = 'windbg' | 'mixed' | 'fallback';

export interface ReportFact {
  label: string;
  value: string;
  mono?: boolean;
}

export interface ReportFacts {
  title: string;
  confidenceLabel: string;
  evidenceSource: EvidenceSource;
  analysisMethodLabel: string;
  primaryCause: string;
  culprit: string;
  bugcheck?: string;
  kernelBuild?: string;
  windowsVersion?: string;
  processName?: string;
  imageName?: string;
  imageVersion?: string;
  moduleName?: string;
  symbolName?: string;
  failureBucketId?: string;
  systemUptime?: string;
  facts: ReportFact[];
  topActions: string[];
  caveat: string;
}

export function getReportFacts(dumpFile: DumpFile): ReportFacts | null {
  return getReportFactsImpl(dumpFile) as ReportFacts | null;
}

export function redactPublicReportText(value: string): string {
  return redactPublicReportTextImpl(value) as string;
}

export function generateForumReport(dumpFile: DumpFile): string {
  return generateForumReportImpl(dumpFile) as string;
}

export function generateMarkdownReport(dumpFile: DumpFile): string {
  return generateMarkdownReportImpl(dumpFile) as string;
}

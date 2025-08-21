import { useCallback, useState } from 'react';
import { DumpFile, FileStatus } from '../types';
import { extractZipSafely } from '../utils/zipSecurity';
import { SECURITY_CONFIG } from '../config/security';
import { validateDumpFile } from '../utils/dumpParser';
import { useError } from './useError';
import { FILE_SIZE_THRESHOLDS } from '../constants';

const DUMP_TYPE_THRESHOLD = FILE_SIZE_THRESHOLDS.MINIDUMP_MAX_SIZE;

export const useFileProcessor = () => {
    const { error, setError, clearError } = useError();

    const processFiles = useCallback(async (
        acceptedFiles: File[], 
        onFileProcessed?: (dumpType: string, fileSize: number) => void
    ): Promise<DumpFile[]> => {
        clearError();
        const newDumpFiles: DumpFile[] = [];

        for (const file of acceptedFiles) {
            const processFile = async (f: File) => {
                // Read file to validate format
                try {
                    const buffer = await f.arrayBuffer();
                    const validation = validateDumpFile(buffer, f.name);
                    
                    if (!validation.isValid) {
                        setError(validation.error || 'Invalid file format');
                        return;
                    }
                    
                    const dumpType = f.size > DUMP_TYPE_THRESHOLD ? 'kernel' : 'minidump';
                    newDumpFiles.push({
                        id: `${f.name}-${Date.now()}`,
                        file: f,
                        status: FileStatus.PENDING,
                        dumpType: dumpType,
                    });
                    if (onFileProcessed) {
                        onFileProcessed(dumpType, f.size);
                    }
                } catch (e) {
                    console.error("Error validating file:", e);
                    setError(`Error processing file ${f.name}: ${e.message}`);
                }
            };

            if (file.name.toLowerCase().endsWith('.zip')) {
                try {
                    const { files: extractedFiles, errors } = await extractZipSafely(file);
                    
                    if (errors.length > 0) {
                        console.error("Errors processing zip file:", errors);
                        setError(errors.join('\n'));
                    }
                    
                    // Check if extracting these files would exceed our limits
                    const totalFiles = newDumpFiles.length + extractedFiles.length;
                    if (totalFiles > SECURITY_CONFIG.file.maxFileCount) {
                        setError(`Too many files. Maximum ${SECURITY_CONFIG.file.maxFileCount} files allowed per session.`);
                        continue;
                    }
                    
                    for (const extractedFile of extractedFiles) {
                        await processFile(extractedFile);
                    }
                } catch (e) {
                    console.error("Error processing zip file:", e);
                    setError(`Error processing ZIP file: ${file.name}`);
                }
            } else if (file.name.toLowerCase().endsWith('.dmp') || 
                       file.name.toLowerCase().endsWith('.mdmp') ||
                       file.name.toLowerCase().endsWith('.hdmp') ||
                       file.name.toLowerCase().endsWith('.kdmp')) {
                await processFile(file);
            } else {
                setError(`Invalid file type: ${file.name}. Please upload .dmp, .mdmp, .hdmp, .kdmp files or ZIP archives containing them.`);
            }
        }

        return newDumpFiles;
    }, []);

    const addFilesToState = useCallback((
        newFiles: DumpFile[], 
        existingFiles: DumpFile[]
    ): DumpFile[] => {
        const existingFileNames = new Set(existingFiles.map(df => df.file.name));
        const uniqueNewFiles = newFiles.filter(df => !existingFileNames.has(df.file.name));
        return [...existingFiles, ...uniqueNewFiles];
    }, []);

    return {
        processFiles,
        addFilesToState,
        error,
        setError,
        DUMP_TYPE_THRESHOLD
    };
};
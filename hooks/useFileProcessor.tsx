import { useCallback, useState } from 'react';
import { DumpFile, FileStatus } from '../types';
import { extractZipSafely } from '../utils/zipSecurity';
import { SECURITY_CONFIG } from '../config/security';

const DUMP_TYPE_THRESHOLD = 5 * 1024 * 1024; // 5 MB

export const useFileProcessor = () => {
    const [error, setError] = useState<string | null>(null);

    const processFiles = useCallback(async (
        acceptedFiles: File[], 
        onFileProcessed?: (dumpType: string, fileSize: number) => void
    ): Promise<DumpFile[]> => {
        setError(null);
        const newDumpFiles: DumpFile[] = [];

        for (const file of acceptedFiles) {
            const processFile = (f: File) => {
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
                        processFile(extractedFile);
                    }
                } catch (e) {
                    console.error("Error processing zip file:", e);
                    setError(`Error processing ZIP file: ${file.name}`);
                }
            } else if (file.name.toLowerCase().endsWith('.dmp')) {
                processFile(file);
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
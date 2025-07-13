import { useCallback, useState } from 'react';
import { DumpFile, FileStatus } from '../types';
import JSZip from 'jszip';

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
                    const zip = await JSZip.loadAsync(file);
                    for (const relativePath in zip.files) {
                        if (relativePath.toLowerCase().endsWith('.dmp')) {
                            const zipEntry = zip.files[relativePath];
                            if (!zipEntry.dir) {
                                const blob = await zipEntry.async('blob');
                                const dmpFile = new File([blob], zipEntry.name, { type: 'application/octet-stream' });
                                processFile(dmpFile);
                            }
                        }
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
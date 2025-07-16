import React, { useState, useCallback } from 'react';
import { UploadIcon } from './Icons';
import { validateFiles } from '../utils/fileValidation';

interface FileUploaderProps {
  onFilesAdded: (files: File[]) => void;
  currentFileCount?: number;
}

const FileUploader: React.FC<FileUploaderProps> = ({ onFilesAdded, currentFileCount = 0 }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const processFiles = useCallback(async (files: File[]) => {
    setValidationErrors([]);
    
    const { validFiles, errors } = await validateFiles(files, currentFileCount);
    
    if (errors.length > 0) {
      setValidationErrors(errors);
      // Show errors for 5 seconds then clear
      setTimeout(() => setValidationErrors([]), 5000);
    }
    
    if (validFiles.length > 0) {
      onFilesAdded(validFiles);
    }
  }, [onFilesAdded, currentFileCount]);

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await processFiles(Array.from(e.dataTransfer.files));
      e.dataTransfer.clearData();
    }
  }, [processFiles]);
  
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
        await processFiles(Array.from(e.target.files));
        // Reset input to allow re-selecting the same file
        e.target.value = '';
    }
  };


  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      className={`upload-area ${isDragging ? 'drag-over' : ''}`}
    >
      <input
        type="file"
        id="file-upload"
        multiple
        accept=".dmp,.zip"
        style={{ position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px', overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', borderWidth: 0 }}
        onChange={handleFileChange}
      />
      <label htmlFor="file-upload" style={{ cursor: 'pointer', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative', zIndex: 2 }}>
          <UploadIcon className="upload-icon" />
          <span className="upload-text">
              Drop .dmp or .zip files here
          </span>
          <span className="upload-hint">or click to browse</span>
          {validationErrors.length > 0 && (
            <div className="validation-errors" style={{ 
              marginTop: '10px', 
              color: '#ff4444',
              fontSize: '14px',
              textAlign: 'center',
              maxWidth: '400px'
            }}>
              {validationErrors.map((error, index) => (
                <div key={index} style={{ marginBottom: '5px' }}>{error}</div>
              ))}
            </div>
          )}
      </label>
    </div>
  );
};

export default FileUploader;
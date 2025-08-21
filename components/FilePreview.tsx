import React from 'react';
import { FileIcon, CloseIcon } from './Icons';

interface FilePreviewProps {
  file: File;
  progress: number;
  onRemove: () => void;
  status: 'pending' | 'processing' | 'completed' | 'error';
  error?: string;
}

const FilePreview: React.FC<FilePreviewProps> = ({ file, progress, onRemove, status, error }) => {
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const getStatusColor = () => {
    switch (status) {
      case 'processing': return 'var(--brand-primary)';
      case 'completed': return 'var(--status-success)';
      case 'error': return 'var(--status-error)';
      default: return 'var(--text-secondary)';
    }
  };

  const getStatusText = () => {
    switch (status) {
      case 'processing': return `Processing... ${progress}%`;
      case 'completed': return 'Ready for analysis';
      case 'error': return error || 'Processing failed';
      default: return 'Waiting...';
    }
  };

  return (
    <div className="file-preview">
      <div className="file-preview-icon">
        <FileIcon />
        {status === 'processing' && (
          <div className="file-preview-progress" style={{ '--progress': `${progress}%` } as React.CSSProperties}>
            <svg className="progress-ring" width="48" height="48">
              <circle
                className="progress-ring-circle"
                stroke={getStatusColor()}
                strokeWidth="3"
                fill="transparent"
                r="22"
                cx="24"
                cy="24"
                strokeDasharray={`${2 * Math.PI * 22}`}
                strokeDashoffset={`${2 * Math.PI * 22 * (1 - progress / 100)}`}
              />
            </svg>
          </div>
        )}
      </div>
      
      <div className="file-preview-info">
        <h4 className="file-preview-name">{file.name}</h4>
        <div className="file-preview-meta">
          <span className="file-preview-size">{formatFileSize(file.size)}</span>
          <span className="file-preview-status" style={{ color: getStatusColor() }}>
            {getStatusText()}
          </span>
        </div>
      </div>
      
      <button 
        className="file-preview-remove"
        onClick={onRemove}
        aria-label="Remove file"
        disabled={status === 'processing'}
      >
        <CloseIcon />
      </button>
    </div>
  );
};

export default FilePreview;
import React, { useState, useCallback, useEffect } from 'react';
import { UploadIcon } from './Icons';
import { validateFiles } from '../utils/fileValidation';
import CloudflareTurnstile from './CloudflareTurnstile';

interface FileUploaderProps {
  onFilesAdded: (files: File[]) => void;
  currentFileCount?: number;
}

const FileUploader: React.FC<FileUploaderProps> = ({ onFilesAdded, currentFileCount = 0 }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [isVerified, setIsVerified] = useState(false);
  const [verificationError, setVerificationError] = useState(false);
  const [mountTime] = useState(() => Date.now());
  
  // Use the provided site key
  const TURNSTILE_SITE_KEY = '0x4AAAAAAABiq2_hH-dGCkQi';
  
  // Check if user already has a valid session cookie
  useEffect(() => {
    const checkExistingSession = () => {
      // Check for turnstile verification cookie
      const cookies = document.cookie.split(';');
      const hasVerification = cookies.some(cookie => 
        cookie.trim().startsWith('bsod_turnstile_verified=true')
      );
      
      if (hasVerification) {
        setIsVerified(true);
      }
    };
    
    checkExistingSession();
    
    // Re-check on focus in case cookie was set in another tab
    const handleFocus = () => checkExistingSession();
    window.addEventListener('focus', handleFocus);
    
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

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
    
    // Require verification before processing files
    if (!isVerified) {
      setValidationErrors(['Please complete the security check first']);
      setTimeout(() => setValidationErrors([]), 3000);
      return;
    }
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await processFiles(Array.from(e.dataTransfer.files));
      e.dataTransfer.clearData();
    }
  }, [processFiles, isVerified]);
  
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    // Require verification before processing files
    if (!isVerified) {
      e.preventDefault();
      e.target.value = '';
      setValidationErrors(['Please complete the security check first']);
      setTimeout(() => setValidationErrors([]), 3000);
      return;
    }
    
    if (e.target.files && e.target.files.length > 0) {
        await processFiles(Array.from(e.target.files));
        // Reset input to allow re-selecting the same file
        e.target.value = '';
    }
  };
  
  const handleTurnstileSuccess = async (token: string) => {
    try {
      // Verify token with backend using Siteverify
      const response = await fetch('/api/auth/verify-turnstile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ 
          token,
          action: 'file-upload', // Must match what's sent to Turnstile widget
          cdata: `files-${currentFileCount}` // Optional context data
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        setIsVerified(true);
        setVerificationError(false);
        
        // Log successful verification
        console.log('Turnstile verified:', {
          challenge_ts: result.challenge_ts,
          hostname: result.hostname
        });
      } else {
        setVerificationError(true);
        
        // Show specific error message based on error code
        const errorMessage = result.error || 'Security verification failed. Please try again.';
        setValidationErrors([errorMessage]);
        
        // If token expired or duplicate, clear verification
        if (result['error-codes']?.includes('timeout-or-duplicate')) {
          setIsVerified(false);
        }
      }
    } catch (error) {
      console.error('Turnstile verification error:', error);
      setVerificationError(true);
      setValidationErrors(['Network error. Please check your connection and try again.']);
    }
  };
  
  const handleTurnstileError = () => {
    setVerificationError(true);
    setValidationErrors(['Security check failed. Please refresh and try again.']);
  };
  
  const handleTurnstileExpire = () => {
    setIsVerified(false);
  };

  // Show Turnstile first, then the upload area
  if (!isVerified) {
    return (
      <div className="upload-area" style={{ padding: '2rem' }}>
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <h3 style={{ marginBottom: '0.5rem', color: 'var(--text-primary)' }}>Security Check Required</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Please complete the security check to upload files
          </p>
        </div>
        
        <CloudflareTurnstile
          key={`turnstile-${mountTime}`}
          siteKey={TURNSTILE_SITE_KEY}
          onSuccess={handleTurnstileSuccess}
          onError={handleTurnstileError}
          onExpire={handleTurnstileExpire}
          action="file-upload"
          cdata={`files-${currentFileCount}`}
        />
        
        {validationErrors.length > 0 && (
          <div className="validation-errors" style={{ 
            marginTop: '1rem', 
            color: '#ff4444',
            fontSize: '14px',
            textAlign: 'center'
          }}>
            {validationErrors.map((error, index) => (
              <div key={index}>{error}</div>
            ))}
          </div>
        )}
      </div>
    );
  }

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
        accept=".dmp,.mdmp,.hdmp,.kdmp,.zip"
        style={{ position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px', overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', borderWidth: 0 }}
        onChange={handleFileChange}
      />
      <label htmlFor="file-upload" style={{ cursor: 'pointer', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative', zIndex: 2 }}>
          <UploadIcon className="upload-icon" />
          <span className="upload-text">
              Drop .dmp or .zip files here
          </span>
          <span className="upload-hint">or click to browse</span>
          <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--text-success)' }}>
            ✓ Security check completed
          </div>
          {validationErrors.length > 0 && (
            <div className="validation-errors" style={{ 
              marginTop: '10px', 
              color: '#ff4444',
              fontSize: '14px',
              textAlign: 'center'
            }}>
              {validationErrors.map((error, index) => (
                <div key={index}>{error}</div>
              ))}
            </div>
          )}
      </label>
    </div>
  );
};

export default FileUploader;
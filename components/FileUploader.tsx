import React, { useState, useCallback, useEffect, useRef, memo } from 'react';
import { UploadIcon } from './Icons';
import { validateFiles } from '../utils/fileValidation';
import CloudflareTurnstile, { type CloudflareTurnstileHandle } from './CloudflareTurnstile';
import { hasTurnstileHint, initializeSession, markSessionInitialized, noteNewSession, onSessionInvalid, startSessionRefresh } from '../utils/sessionManager';
import { ALLOWED_EXTENSIONS } from '../shared/ingestPolicy.js';

interface FileUploaderProps {
  onFilesAdded: (files: File[]) => void;
  currentFileCount?: number;
  /** When true (data-use terms unchecked) no files are accepted or uploaded. */
  disabled?: boolean;
}

const FileUploader: React.FC<FileUploaderProps> = memo(({ onFilesAdded, currentFileCount = 0, disabled = false }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [isVerified, setIsVerified] = useState(false);
  const [verificationError, setVerificationError] = useState(false);
  const turnstileRef = useRef<CloudflareTurnstileHandle>(null);
  // Bumped by "Retry security check" to remount the widget (and reload a
  // script that failed to load).
  const [turnstileAttempt, setTurnstileAttempt] = useState(0);
  // Whether this attempt already reset the widget once (issue #277).
  const autoResetUsed = useRef(false);
  
  // Use the provided site key
  const TURNSTILE_SITE_KEY = '0x4AAAAAAABiq2_hH-dGCkQi';
  
  // Check if user already has a valid session cookie
  useEffect(() => {
    let cancelled = false;

    const checkExistingSession = async () => {
      if (!hasTurnstileHint()) {
        if (!cancelled) setIsVerified(false);
        return;
      }

      const sessionValid = await initializeSession(true);
      if (!cancelled) {
        setIsVerified(sessionValid);
        if (sessionValid) {
          startSessionRefresh('uploader');
        }
      }
    };
    
    checkExistingSession();
    
    // Re-check on focus in case cookie was set in another tab
    const handleFocus = () => checkExistingSession();
    window.addEventListener('focus', handleFocus);
    const unsubscribeSessionInvalid = onSessionInvalid(() => {
      setIsVerified(false);
      setValidationErrors(['Please complete the security check again']);
    });
    
    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleFocus);
      unsubscribeSessionInvalid();
    };
  }, []);

  const ensureVerifiedSession = useCallback(async () => {
    if (!isVerified) {
      setValidationErrors(['Please complete the security check first']);
      setTimeout(() => setValidationErrors([]), 3000);
      return false;
    }

    const sessionValid = await initializeSession(true);
    if (!sessionValid) {
      setIsVerified(false);
      setValidationErrors(['Please complete the security check again']);
      return false;
    }

    startSessionRefresh('uploader');
    return true;
  }, [isVerified]);

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
    if (disabled) return;
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
  }, [onFilesAdded, currentFileCount, disabled]);

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    // Extract files synchronously before any async await yields the event loop!
    const droppedFiles = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
    
    // Require verification before processing files
    if (!await ensureVerifiedSession()) {
      return;
    }
    
    if (droppedFiles.length > 0) {
      await processFiles(droppedFiles);
    }
  }, [processFiles, ensureVerifiedSession]);
  
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    // Extract files synchronously before any async await yields the event loop!
    const selectedFiles = e.target.files ? Array.from(e.target.files) : [];

    // Require verification before processing files
    if (!await ensureVerifiedSession()) {
      e.preventDefault();
      e.target.value = '';
      return;
    }
    
    if (selectedFiles.length > 0) {
        await processFiles(selectedFiles);
        // Reset input to allow re-selecting the same file
        e.target.value = '';
    }
  };
  
  const handleTurnstileSuccess = useCallback(async (token: string) => {
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
        setValidationErrors([]);
        autoResetUsed.current = false;
        // Verification mints a new session id (#341).
        noteNewSession();
        markSessionInitialized();
        startSessionRefresh('uploader');

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

        // Turnstile tokens are single-use: when Siteverify says the token was
        // spent or invalid, ask the widget for a fresh one, once per attempt.
        // With the default `execution: 'render'` a reset re-solves and calls
        // back on its own, so resetting on errors a new token cannot fix (429,
        // 5xx, bad secret, action/hostname mismatch) looped POSTs unboundedly
        // (issue #277); those wait for the visitor's "Retry security check".
        const codes: unknown[] = Array.isArray(result['error-codes']) ? result['error-codes'] : [];
        const tokenProblem = codes.some(code => code === 'timeout-or-duplicate' || code === 'invalid-input-response');
        if (tokenProblem && !autoResetUsed.current) {
          autoResetUsed.current = true;
          turnstileRef.current?.reset();
        }
      }
    } catch (error) {
      // Network failure or a non-JSON answer: no automatic retry (issue #277).
      console.error('Turnstile verification error:', error);
      setVerificationError(true);
      setValidationErrors(['Network error. Please check your connection and try again.']);
    }
  }, [currentFileCount]);

  const handleTurnstileError = useCallback(() => {
    setVerificationError(true);
    setValidationErrors(['Security check failed. Please try again.']);
  }, []);

  const retryTurnstile = useCallback(() => {
    autoResetUsed.current = false;
    setVerificationError(false);
    setValidationErrors([]);
    setTurnstileAttempt(attempt => attempt + 1);
  }, []);

  const handleTurnstileExpire = useCallback(() => {
    setIsVerified(false);
  }, []);

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
          key={turnstileAttempt}
          ref={turnstileRef}
          siteKey={TURNSTILE_SITE_KEY}
          onSuccess={handleTurnstileSuccess}
          onError={handleTurnstileError}
          onExpire={handleTurnstileExpire}
          action="file-upload"
        />
        
        {validationErrors.length > 0 && (
          <div id="file-upload-errors" role="alert" className="validation-errors" style={{ 
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
        {verificationError && (
          <div style={{ marginTop: '1rem', textAlign: 'center' }}>
            <button type="button" className="btn btn-secondary" onClick={retryTurnstile}>
              Retry security check
            </button>
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
      className={`upload-area ${isDragging && !disabled ? 'drag-over' : ''}`}
      data-disabled={disabled ? 'true' : undefined}
      aria-disabled={disabled || undefined}
    >
      <input
        type="file"
        id="file-upload"
        disabled={disabled}
        multiple
        accept={ALLOWED_EXTENSIONS.join(',')}
        style={{ position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px', overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', borderWidth: 0 }}
        onChange={handleFileChange}
        aria-describedby={validationErrors.length > 0 ? 'file-upload-errors' : undefined}
        aria-invalid={validationErrors.length > 0 || undefined}
      />
      <label htmlFor="file-upload" style={{ cursor: 'pointer', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative', zIndex: 2 }}>
          <UploadIcon className="upload-icon" />
          <span className="upload-text">
              Drop dump files or .zip, .7z, or .rar archives here
          </span>
          <span className="upload-hint">or click to browse</span>
          <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--status-success)' }}>
            ✓ Security check completed
          </div>
      </label>
      {validationErrors.length > 0 && (
        <div id="file-upload-errors" role="alert" className="validation-errors" style={{
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
    </div>
  );
});

FileUploader.displayName = 'FileUploader';

export default FileUploader;

import { useState, useCallback } from 'react';

interface UseErrorReturn {
  error: string | null;
  setError: (error: string | null) => void;
  clearError: () => void;
  setErrorWithTimeout: (error: string, timeout?: number) => void;
}

export function useError(initialError: string | null = null): UseErrorReturn {
  const [error, setError] = useState<string | null>(initialError);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const setErrorWithTimeout = useCallback((error: string, timeout = 5000) => {
    setError(error);
    setTimeout(() => {
      setError(null);
    }, timeout);
  }, []);

  return {
    error,
    setError,
    clearError,
    setErrorWithTimeout
  };
}
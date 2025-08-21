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

// Hook for validation errors with field tracking
interface ValidationError {
  field: string;
  message: string;
}

interface UseValidationErrorsReturn {
  errors: ValidationError[];
  addError: (field: string, message: string) => void;
  removeError: (field: string) => void;
  clearErrors: () => void;
  hasError: (field: string) => boolean;
  getError: (field: string) => string | undefined;
}

export function useValidationErrors(): UseValidationErrorsReturn {
  const [errors, setErrors] = useState<ValidationError[]>([]);

  const addError = useCallback((field: string, message: string) => {
    setErrors(prev => {
      const filtered = prev.filter(e => e.field !== field);
      return [...filtered, { field, message }];
    });
  }, []);

  const removeError = useCallback((field: string) => {
    setErrors(prev => prev.filter(e => e.field !== field));
  }, []);

  const clearErrors = useCallback(() => {
    setErrors([]);
  }, []);

  const hasError = useCallback((field: string) => {
    return errors.some(e => e.field === field);
  }, [errors]);

  const getError = useCallback((field: string) => {
    return errors.find(e => e.field === field)?.message;
  }, [errors]);

  return {
    errors,
    addError,
    removeError,
    clearErrors,
    hasError,
    getError
  };
}
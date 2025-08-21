// AMP TypeScript declarations
declare namespace JSX {
  interface IntrinsicElements {
    'amp-img': {
      src: string;
      width: string | number;
      height: string | number;
      layout?: 'responsive' | 'fixed' | 'fixed-height' | 'fill' | 'flex-item' | 'intrinsic' | 'nodisplay';
      alt?: string;
      attribution?: string;
      placeholder?: boolean;
      fallback?: boolean;
    };
    
    'amp-analytics': {
      type?: string;
      config?: string;
      'data-credentials'?: 'include' | 'omit' | 'same-origin';
      children?: React.ReactNode;
    };
    
    'amp-auto-ads': {
      type: string;
      'data-ad-client': string;
    };
    
    'amp-ad': {
      width: string | number;
      height: string | number;
      type: string;
      'data-ad-client'?: string;
      'data-ad-slot'?: string;
      'data-auto-format'?: string;
      'data-full-width'?: boolean;
    };
    
    'amp-video': {
      src?: string;
      poster?: string;
      width: string | number;
      height: string | number;
      layout?: 'responsive' | 'fixed' | 'fixed-height' | 'fill' | 'flex-item' | 'intrinsic' | 'nodisplay';
      autoplay?: boolean;
      controls?: boolean;
      loop?: boolean;
      muted?: boolean;
    };
    
    'amp-carousel': {
      width: string | number;
      height: string | number;
      layout?: 'responsive' | 'fixed' | 'fixed-height' | 'fill' | 'flex-item' | 'intrinsic' | 'nodisplay';
      type?: 'slides' | 'carousel';
      'data-next-button-aria-label'?: string;
      'data-prev-button-aria-label'?: string;
      children?: React.ReactNode;
    };
    
    'amp-accordion': {
      'data-expand-single-section'?: boolean;
      'data-disable-session-states'?: boolean;
      children?: React.ReactNode;
    };
    
    'amp-sidebar': {
      id: string;
      layout: 'nodisplay';
      side?: 'left' | 'right';
      children?: React.ReactNode;
    };
    
    'amp-script': {
      src?: string;
      width?: string | number;
      height?: string | number;
      layout?: 'container' | 'fixed' | 'fixed-height' | 'responsive' | 'fill' | 'flex-item' | 'intrinsic' | 'nodisplay';
      'data-ampdevmode'?: boolean;
      children?: React.ReactNode;
    };
  }
}

// Global AMP attributes
declare global {
  namespace React {
    interface HTMLAttributes<T> {
      '⚡'?: boolean;
      'amp'?: boolean;
      'amp-boilerplate'?: boolean;
      'amp-custom'?: boolean;
    }
  }
}

export {};
import React from 'react';

// Props for standard SVG icons
interface IconProps {
  className?: string;
}

export const AnimatedLogoIcon: React.FC = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path className="logo-path" d="M12 2L12 6" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
        <path className="logo-path" d="M12 18L12 22" stroke="white" strokeWidth="1.5" strokeLinecap="round" style={{animationDelay: '0.1s'}}/>
        <path className="logo-path" d="M22 12L18 12" stroke="white" strokeWidth="1.5" strokeLinecap="round" style={{animationDelay: '0.2s'}}/>
        <path className="logo-path" d="M6 12L2 12" stroke="white" strokeWidth="1.5" strokeLinecap="round" style={{animationDelay: '0.3s'}}/>
        <path className="logo-path" d="M19.0711 4.92896L16.2426 7.75739" stroke="white" strokeWidth="1.5" strokeLinecap="round" style={{animationDelay: '0.4s'}}/>
        <path className="logo-path" d="M7.75732 16.2427L4.92889 19.0711" stroke="white" strokeWidth="1.5" strokeLinecap="round" style={{animationDelay: '0.5s'}}/>
        <path className="logo-path" d="M19.0711 19.0711L16.2426 16.2427" stroke="white" strokeWidth="1.5" strokeLinecap="round" style={{animationDelay: '0.6s'}}/>
        <path className="logo-path" d="M7.75732 7.75739L4.92889 4.92896" stroke="white" strokeWidth="1.5" strokeLinecap="round" style={{animationDelay: '0.7s'}}/>
        <rect x="8" y="8" width="8" height="8" rx="1" stroke="white" strokeWidth="1.5" className="logo-glow"/>
    </svg>
);


export const AnalyzeIcon: React.FC<IconProps> = ({ className = "w-5 h-5" }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
);

export const UploadIcon: React.FC<IconProps> = ({ className = "upload-icon" }) => (
  <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
  </svg>
);

export const FileIcon: React.FC<IconProps> = ({ className = "w-6 h-6" }) => (
  <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
  </svg>
);

export const ZipIcon: React.FC<IconProps> = ({ className = "w-6 h-6" }) => (
  <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} style={{color: 'var(--status-warning)'}}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
  </svg>
);

export const ChevronDownIcon: React.FC<IconProps> = ({ className = "w-5 h-5" }) => (
  <svg xmlns="http://www.w3.org/2000/svg" className={className} viewBox="0 0 20 20" fill="currentColor">
    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
  </svg>
);

export const ChevronUpIcon: React.FC<IconProps> = ({ className = "w-5 h-5" }) => (
  <svg xmlns="http://www.w3.org/2000/svg" className={className} viewBox="0 0 20 20" fill="currentColor">
    <path fillRule="evenodd" d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z" clipRule="evenodd" />
  </svg>
);

export const TerminalIcon: React.FC<IconProps> = ({ className = "w-5 h-5" }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
    </svg>
);

export const UploadFeatureIcon: React.FC<IconProps> = ({ className }) => (
    <svg className={className} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path className="icon-bg-glow" d="M49.7 33.4C49.5 33.4 49.2 33.4 49 33.4c-2.3-6.6-8.5-11.4-15.9-11.4c-5.2 0-9.9 2.4-12.9 6.2c-1.2-0.5-2.5-0.8-3.8-0.8c-5.5 0-10 4.5-10 10s4.5 10 10 10h32c4.4 0 8-3.6 8-8S53.4 33.4 49.7 33.4z" fill="var(--brand-primary)" opacity="0.2"/>
        <path className="icon-stroke" d="M32 45V29" stroke="var(--brand-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{animationDelay: '0.2s'}} />
        <path className="icon-stroke" d="M26 35L32 29L38 35" stroke="var(--brand-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

export const AnalyzeFeatureIcon: React.FC<IconProps> = ({ className }) => (
    <svg className={className} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle className="icon-bg-glow" cx="32" cy="32" r="24" fill="var(--brand-primary)" opacity="0.2"/>
        <path className="icon-stroke" d="M41.998 42L49.998 50" stroke="var(--brand-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{animationDelay: '0.4s'}}/>
        <circle className="icon-stroke" cx="29" cy="29" r="13" stroke="var(--brand-accent)" strokeWidth="2"/>
        <path className="icon-pulse" d="M29 23V35" stroke="var(--brand-accent)" strokeWidth="2" strokeLinecap="round"/>
        <path className="icon-pulse" d="M23 29H35" stroke="var(--brand-accent)" strokeWidth="2" strokeLinecap="round" style={{animationDelay: '0.2s'}}/>
    </svg>
);

export const ResolveFeatureIcon: React.FC<IconProps> = ({ className }) => (
    <svg className={className} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path className="icon-bg-glow" d="M32 60C16.536 60 4 47.464 4 32C4 16.536 16.536 4 32 4C47.464 4 60 16.536 60 32C60 47.464 47.464 60 32 60Z" fill="var(--brand-primary)" opacity="0.2"/>
        <path className="icon-pulse" d="M32 52C21.022 52 12 42.978 12 32C12 21.022 21.022 12 32 12C42.978 12 52 21.022 52 32C52 42.978 42.978 52 32 52Z" stroke="var(--brand-accent)" strokeOpacity="0.5" strokeWidth="2"/>
        <path className="icon-stroke" d="M24 32.5L29.5 38L42 26" stroke="var(--brand-accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
);

export const ClipboardIcon: React.FC<IconProps> = ({ className = "w-5 h-5" }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
    </svg>
);

export const CheckIcon: React.FC<IconProps> = ({ className = "w-5 h-5" }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
);

export const DownloadIcon: React.FC<IconProps> = ({ className = "w-5 h-5" }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
);

export const ShareIcon: React.FC<IconProps> = ({ className = "w-5 h-5" }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12s-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.367 2.684 3 3 0 00-5.367-2.684z" />
    </svg>
);

export const TwitterIcon: React.FC<IconProps> = ({ className = "w-5 h-5" }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="currentColor" viewBox="0 0 24 24">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
);
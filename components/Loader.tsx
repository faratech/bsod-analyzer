import React from 'react';

interface LoaderProps {
  // Full-viewport centering for the route-level Suspense fallback, where it
  // stops the footer from shifting while a page chunk loads. Inline uses (the
  // "Analyzing" status pill and card body) get the bare spinner (issue #157).
  fullPage?: boolean;
}

const Loader: React.FC<LoaderProps> = ({ fullPage = false }) => {
  const spinner = <div className="loader"></div>;
  if (!fullPage) return spinner;
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {spinner}
    </div>
  );
};

export default Loader;

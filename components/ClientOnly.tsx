import React, { useEffect, useState } from 'react';

/**
 * Renders children only after the component has mounted on the client.
 *
 * Used to wrap document-metadata components (SEO, StructuredData) so they are
 * absent from both the server-prerendered HTML and the first client render —
 * keeping hydration exact — then injected post-mount (React 19 hoists the
 * <title>/<meta>/<script> into <head>). The static <head> in index.html already
 * carries the homepage's canonical title/OG/structured-data, so crawlers and
 * first paint are unaffected.
 */
const ClientOnly: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted ? <>{children}</> : null;
};

export default ClientOnly;

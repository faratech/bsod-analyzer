// Data-use terms checkbox for the analyzer (checked by default). Unchecking it
// disables uploading and analysis: every analysis is kept to improve BSOD AI and
// feeds anonymous aggregate statistics (see /privacy). The first render is always
// "checked" so it matches the prerendered /analyzer page; a remembered opt-out is
// applied after mount.
import React, { useEffect, useId } from 'react';
import { Link } from 'react-router-dom';
import { DATA_USE_STORAGE_KEY, setDataUseAccepted } from '../utils/dataUse';

interface DataUseAgreementProps {
  accepted: boolean;
  onChange: (accepted: boolean) => void;
}

const DataUseAgreement: React.FC<DataUseAgreementProps> = ({ accepted, onChange }) => {
  const id = useId();
  const helpId = `${id}-help`;

  useEffect(() => {
    try {
      if (window.localStorage.getItem(DATA_USE_STORAGE_KEY) === '1') onChange(false);
    } catch { /* storage unavailable: keep the default */ }
    // Restore once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setDataUseAccepted(accepted);
    try {
      if (accepted) window.localStorage.removeItem(DATA_USE_STORAGE_KEY);
      else window.localStorage.setItem(DATA_USE_STORAGE_KEY, '1');
    } catch { /* ignore */ }
  }, [accepted]);

  return (
    <div className={`data-use ${accepted ? '' : 'is-declined'}`}>
      <label className="data-use-row" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={accepted}
          onChange={e => onChange(e.target.checked)}
          aria-describedby={helpId}
        />
        <span className="data-use-label">Use my crash analysis to improve BSOD AI</span>
      </label>
      <p id={helpId} className="data-use-help">
        {accepted ? (
          <>
            We keep the analysis of your dump to train and improve our AI, and to publish anonymous,
            aggregate crash statistics. We never publish your dump or its contents.{' '}
            <Link to="/privacy">How we use your data</Link>
          </>
        ) : (
          <>
            No problem. BSOD AI can&apos;t analyze dumps without this, because every analysis is part of
            how the AI learns. Nothing is uploaded while it&apos;s unchecked, and you can check it again
            any time.{' '}
            <Link to="/privacy">How we use your data</Link>
          </>
        )}
      </p>
    </div>
  );
};

export default DataUseAgreement;

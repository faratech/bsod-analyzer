// Data-use terms checkbox for the analyzer (checked by default). Unchecking it
// disables uploading and analysis: every analysis is kept to improve BSOD AI and
// feeds anonymous aggregate statistics (see /privacy). The first render is always
// "checked" so it matches the prerendered /analyzer page; a remembered opt-out,
// or terms that changed since this browser last agreed, is applied after mount.
import React, { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  DATA_USE_STORAGE_KEY,
  dataUseTermsChangedSinceAcceptance,
  rememberDataUseAcceptance,
  setDataUseAccepted,
} from '../utils/dataUse';

interface DataUseAgreementProps {
  accepted: boolean;
  onChange: (accepted: boolean) => void;
}

const DataUseAgreement: React.FC<DataUseAgreementProps> = ({ accepted, onChange }) => {
  const id = useId();
  const helpId = `${id}-help`;
  const [termsChanged, setTermsChanged] = useState(false);

  useEffect(() => {
    // The terms changed since this browser agreed: ask again (issue #144).
    if (dataUseTermsChangedSinceAcceptance()) {
      setTermsChanged(true);
      onChange(false);
      return;
    }
    try {
      if (window.localStorage.getItem(DATA_USE_STORAGE_KEY) === '1') onChange(false);
    } catch { /* storage unavailable: keep the default */ }
    // Restore once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (checked: boolean) => {
    if (checked) {
      // Checking the box is an explicit agreement to the current terms.
      rememberDataUseAcceptance();
      setTermsChanged(false);
    }
    onChange(checked);
  };

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
          onChange={e => handleChange(e.target.checked)}
          aria-describedby={helpId}
        />
        <span className="data-use-label">Use my crash analysis to improve BSOD AI</span>
      </label>
      <p id={helpId} className="data-use-help">
        {accepted ? (
          <>
            We keep the analysis of your dump to train and improve our AI, and to publish anonymous,
            aggregate crash statistics here and on WindowsForum. We never publish your dump or its contents.{' '}
            <Link to="/privacy">How we use your data</Link>
          </>
        ) : termsChanged ? (
          <>
            Our data-use terms changed since you last agreed. Please review them and check the box to
            accept the updated terms. Nothing is uploaded until you do.{' '}
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

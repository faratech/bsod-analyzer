// Privacy notice for the BSOD analyzer (/privacy). Keep it factual: every
// statement here must match what the service actually does (see CLAUDE.md
// "WinDBG corpus", "Stats & insights pipeline" and shared/dataUseTerms.js).
import React from 'react';
import { Link } from 'react-router-dom';
import PageLayout from '../components/PageLayout';
import SEO from '../components/SEO';
import { DATA_USE_TERMS_VERSION } from '../shared/dataUseTerms.js';

const Privacy: React.FC = () => (
  <PageLayout
    title="Privacy & data use"
    subtitle="What happens to the crash dumps you analyze"
    description="How BSOD AI Analyzer uses crash dumps: producing your report, improving our AI, and publishing anonymous aggregate statistics."
    keywords="bsod analyzer privacy, crash dump data use, windbg analysis privacy"
    canonicalPath="/privacy"
  >
    <SEO
      title="Privacy & data use"
      description="How BSOD AI Analyzer uses crash dumps: producing your report, improving our AI, and publishing anonymous aggregate statistics."
    />
    <div className="privacy-page">
      <p className="privacy-lede">
        This notice covers the BSOD AI Analyzer at bsod.windowsforum.com and its API. It applies alongside the{' '}
        <a href="https://windowsforum.com/help/privacy-policy/" target="_blank" rel="noopener noreferrer">WindowsForum privacy policy</a>.
        {' '}Terms version {DATA_USE_TERMS_VERSION}.
      </p>

      <section>
        <h2>The short version</h2>
        <ul>
          <li>We analyze your crash dump with WinDBG and an AI model to produce your report.</li>
          <li>We keep the analysis to <strong>improve our AI</strong>, and we publish <strong>anonymous, aggregate crash statistics</strong> on the <Link to="/stats">statistics page</Link>.</li>
          <li>We never publish your dump, its analysis, its file name, or anything that identifies you or your PC.</li>
          <li>Using the analyzer requires agreeing to this. If you&apos;d rather not, uncheck <em>Use my crash analysis to improve BSOD AI</em> on the analyzer and nothing will be uploaded.</li>
        </ul>
      </section>

      <section>
        <h2>What we receive</h2>
        <ul>
          <li>The dump file you upload (or the dumps inside an archive you upload), with its file name, size and a hash of its contents.</li>
          <li>The analysis output WinDBG produces from it. Crash dumps and their analysis can contain details about your PC: Windows version and build, installed drivers and their versions, hardware details, running process names, and file paths, which may include your Windows user folder name.</li>
          <li>The report our AI writes from that analysis.</li>
          <li>Standard request data such as your IP address, used for security, rate limiting and abuse prevention.</li>
        </ul>
      </section>

      <section>
        <h2>How we use it</h2>
        <ul>
          <li><strong>To produce your report.</strong></li>
          <li><strong>To improve our AI.</strong> We keep analyses and the AI reports written from them as training and evaluation data for BSOD AI.</li>
          <li><strong>To publish anonymous statistics.</strong> The <Link to="/stats">statistics page</Link> shows only aggregate counts across many dumps, such as the most common stop codes, drivers and Windows versions.</li>
          <li>To give the AI context, prompts can include aggregate statistics from earlier analyses, such as how often a stop code is caused by a given driver. These contain no individual dump data.</li>
        </ul>
      </section>

      <section>
        <h2>Who processes it</h2>
        <ul>
          <li><strong>WinDBG analysis server</strong> operated by Stack Tech, which runs the debugger on your dump.</li>
          <li><strong>Google Cloud</strong> (United States) hosts the website and stores analyses and statistics (Cloud Run, BigQuery, Cloud Storage).</li>
          <li><strong>AI providers</strong> write the report from a structured summary of the WinDBG output: DeepSeek, Experiential Labs, OpenAI, Google (Gemini) and OpenRouter, depending on availability. The dump file itself is not sent to them.</li>
          <li><strong>Cloudflare</strong> provides security checks (Turnstile) and delivers the site; <strong>Google AdSense</strong> shows ads on some pages and may use cookies under Google&apos;s own policies.</li>
        </ul>
      </section>

      <section>
        <h2>How long we keep it</h2>
        <ul>
          <li>The website does not store uploaded files; it passes them to the analysis server.</li>
          <li>The analysis server currently keeps uploaded dump files. It keeps its own full copy of the analysis output for about 30 days after that analysis is stored in our private dataset, then keeps only a short summary.</li>
          <li>The stored analysis and AI report are kept in our private dataset to improve the AI. They are not public.</li>
          <li>Server logs are kept for up to 30 days.</li>
        </ul>
      </section>

      <section>
        <h2>Your choices</h2>
        <ul>
          <li>You can decline by unchecking the box on the <Link to="/analyzer">analyzer</Link>. The analyzer can&apos;t be used while it&apos;s unchecked, and nothing is uploaded.</li>
          <li>To ask us to delete an analysis you submitted, <a href="https://windowsforum.com/misc/contact" target="_blank" rel="noopener noreferrer">contact us</a> with the dump&apos;s file name and the date you analyzed it.</li>
        </ul>
      </section>

      <section>
        <h2>API users</h2>
        <p>Dumps submitted through the BSOD Analyzer API are handled the same way. Using an API key means you accept this notice on behalf of the dumps you submit.</p>
      </section>

      <section>
        <h2>Changes</h2>
        <p>If we change how crash data is used, we&apos;ll update this page and its terms version, and the analyzer will ask you to agree again.</p>
      </section>
    </div>
  </PageLayout>
);

export default Privacy;

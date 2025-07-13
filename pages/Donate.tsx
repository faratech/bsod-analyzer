import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import PayPalDonateButton from '../components/PayPalDonateButton';
import SEO from '../components/SEO';

const Donate: React.FC = () => {
    const [selectedOneTimeAmount, setSelectedOneTimeAmount] = useState<string>('10');
    const [selectedMonthlyAmount, setSelectedMonthlyAmount] = useState<string>('5');
    const [showSuccessMessage, setShowSuccessMessage] = useState(false);
    const location = useLocation();

    useEffect(() => {
        // Check if user returned from successful PayPal donation
        const params = new URLSearchParams(location.search);
        if (params.get('success') === 'true') {
            setShowSuccessMessage(true);
            // Clear the success parameter from URL
            window.history.replaceState({}, '', '/donate');
        }
    }, [location]);
    return (
        <>
            <SEO 
                title="Support BSOD AI Analyzer - Donate"
                description="Support the development of BSOD AI Analyzer. Your donations help keep this free tool available for everyone. Multiple payment options available including PayPal and cryptocurrency."
                keywords="donate BSOD analyzer, support Windows debugging, PayPal donation, cryptocurrency donation"
                canonicalUrl="https://bsod.windowsforum.com/donate"
            />
            <main className="page-content">
                <div className="container">
                    <div className="content-wrapper donate-page">
                    <h1>Support BSOD AI Analyzer</h1>
                    
                    {showSuccessMessage && (
                        <div className="success-message fade-in">
                            <h2>Thank You for Your Support!</h2>
                            <p>Your donation helps us keep BSOD AI Analyzer free and accessible for everyone. 
                            We truly appreciate your generosity!</p>
                        </div>
                    )}
                    
                    <div className="donate-hero">
                        <p className="donate-intro">
                            BSOD AI Analyzer is a free service that helps thousands of users diagnose 
                            and fix Windows crashes every day. Your support helps us maintain and improve 
                            this tool for everyone.
                        </p>
                    </div>

                    <section className="content-section">
                        <h2>Why Donate?</h2>
                        <div className="donate-reasons">
                            <div className="donate-reason">
                                <h3>Keep It Free</h3>
                                <p>Your donations ensure BSOD AI Analyzer remains free and accessible to everyone, 
                                regardless of their technical expertise or financial situation.</p>
                            </div>
                            <div className="donate-reason">
                                <h3>Support Development</h3>
                                <p>Contributions fund ongoing development, including new features, better AI models, 
                                and support for more crash scenarios.</p>
                            </div>
                            <div className="donate-reason">
                                <h3>Cover Costs</h3>
                                <p>AI analysis, server infrastructure, and continuous improvements require resources. 
                                Your support helps cover these operational costs.</p>
                            </div>
                        </div>
                    </section>

                    <section className="content-section donate-options">
                        <h2>Ways to Support</h2>
                        
                        <div className="donate-cards">
                            <div className="donate-card">
                                <h3>One-Time Donation</h3>
                                <p>Make a single contribution of any amount</p>
                                <div className="donate-amounts">
                                    <button 
                                        className={`btn btn-donate ${selectedOneTimeAmount === '5' ? 'active' : ''}`}
                                        onClick={() => setSelectedOneTimeAmount('5')}
                                    >
                                        $5
                                    </button>
                                    <button 
                                        className={`btn btn-donate ${selectedOneTimeAmount === '10' ? 'active' : ''}`}
                                        onClick={() => setSelectedOneTimeAmount('10')}
                                    >
                                        $10
                                    </button>
                                    <button 
                                        className={`btn btn-donate ${selectedOneTimeAmount === '25' ? 'active' : ''}`}
                                        onClick={() => setSelectedOneTimeAmount('25')}
                                    >
                                        $25
                                    </button>
                                    <button 
                                        className={`btn btn-donate ${selectedOneTimeAmount === '50' ? 'active' : ''}`}
                                        onClick={() => setSelectedOneTimeAmount('50')}
                                    >
                                        $50
                                    </button>
                                </div>
                                <PayPalDonateButton 
                                    amount={selectedOneTimeAmount}
                                    buttonText={`Donate $${selectedOneTimeAmount} via PayPal`}
                                    isMonthly={false}
                                />
                            </div>
                            
                            <div className="donate-card featured">
                                <div className="featured-badge">Most Popular</div>
                                <h3>Monthly Support</h3>
                                <p>Become a sustaining supporter</p>
                                <div className="donate-amounts">
                                    <button 
                                        className={`btn btn-donate ${selectedMonthlyAmount === '3' ? 'active' : ''}`}
                                        onClick={() => setSelectedMonthlyAmount('3')}
                                    >
                                        $3/mo
                                    </button>
                                    <button 
                                        className={`btn btn-donate ${selectedMonthlyAmount === '5' ? 'active' : ''}`}
                                        onClick={() => setSelectedMonthlyAmount('5')}
                                    >
                                        $5/mo
                                    </button>
                                    <button 
                                        className={`btn btn-donate ${selectedMonthlyAmount === '10' ? 'active' : ''}`}
                                        onClick={() => setSelectedMonthlyAmount('10')}
                                    >
                                        $10/mo
                                    </button>
                                </div>
                                <PayPalDonateButton 
                                    amount={selectedMonthlyAmount}
                                    buttonText={`Subscribe $${selectedMonthlyAmount}/month via PayPal`}
                                    isMonthly={true}
                                />
                            </div>
                            
                            <div className="donate-card">
                                <h3>Cryptocurrency</h3>
                                <p>Support us with crypto donations</p>
                                <div className="crypto-options">
                                    <div className="crypto-option">
                                        <strong>Bitcoin:</strong>
                                        <code className="crypto-address">3AEtTB5AtX6qduDK6VZEFsnDQ2RDsgD3tX</code>
                                    </div>
                                    <div className="crypto-option">
                                        <strong>Ethereum:</strong>
                                        <code className="crypto-address">0xe46B41cE4F9382004f366B03678c6B1b6CEF7a26</code>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </section>

                    <section className="content-section">
                        <h2>Other Ways to Help</h2>
                        
                        <div className="help-options">
                            <div className="help-option">
                                <h3>Spread the Word</h3>
                                <p>Share BSOD AI Analyzer with friends, forums, and social media. Help others 
                                discover this free tool for solving Windows crashes.</p>
                            </div>
                            
                            <div className="help-option">
                                <h3>Contribute on GitHub</h3>
                                <p>Developers can contribute code, report bugs, or suggest features on our 
                                GitHub repository. Every contribution makes the tool better.</p>
                            </div>
                            
                            <div className="help-option">
                                <h3>Provide Feedback</h3>
                                <p>Your feedback helps us improve. Share your experience, report issues, or 
                                suggest new features through our contact form.</p>
                            </div>
                        </div>
                    </section>

                    <section className="content-section">
                        <h2>Thank You!</h2>
                        <p className="thank-you-message">
                            Whether you donate, contribute code, or simply use and share our tool, 
                            you're part of making Windows troubleshooting accessible to everyone. 
                            Thank you for your support!
                        </p>
                    </section>

                    <section className="content-section sponsors">
                        <h2>Our Supporters</h2>
                        <p>Special thanks to these organizations and individuals who support our mission:</p>
                        <div className="sponsor-list">
                            <div className="sponsor">WindowsForum Community</div>
                            <div className="sponsor">Fara Technologies LLC</div>
                        </div>
                    </section>
                </div>
            </div>
        </main>
        </>
    );
};

export default Donate;
import React from 'react';
import { Link } from 'react-router-dom';

const Footer: React.FC = () => {
    return (
        <footer className="footer">
            <div className="container">
                <div className="footer-content">
                    <div className="footer-section">
                        <div className="footer-brand">
                            <span className="footer-company">Fara Technologies LLC</span>
                            <span className="footer-tagline">In partnership with WindowsForum</span>
                        </div>
                        <p className="footer-description">
                            Professional BSOD analysis powered by advanced AI technology. 
                            Get instant insights into Windows crash dumps.
                        </p>
                    </div>
                    
                    <div className="footer-section">
                        <h4 className="footer-heading">Resources</h4>
                        <div className="footer-links">
                            <Link to="/documentation" className="footer-link">Documentation</Link>
                            <Link to="/about" className="footer-link">How It Works</Link>
                            <a href="https://windowsforum.com" target="_blank" rel="noopener noreferrer" className="footer-link">WindowsForum</a>
                        </div>
                    </div>
                    
                    <div className="footer-section">
                        <h4 className="footer-heading">Support</h4>
                        <div className="footer-links">
                            <Link to="/donate" className="footer-link">Donate</Link>
                            <a href="https://github.com/faratech/bsod-analyzer" target="_blank" rel="noopener noreferrer" className="footer-link">GitHub</a>
                            <a href="https://windowsforum.com/contact" target="_blank" rel="noopener noreferrer" className="footer-link">Contact</a>
                        </div>
                    </div>
                    
                    <div className="footer-section">
                        <h4 className="footer-heading">Legal</h4>
                        <div className="footer-links">
                            <a href="https://windowsforum.com/privacy-policy" className="footer-link">Privacy Policy</a>
                            <a href="https://windowsforum.com/help/terms/" className="footer-link">Terms of Service</a>
                        </div>
                    </div>
                </div>
                
                <div className="footer-bottom">
                    <p>&copy; 2024 Fara Technologies LLC. All rights reserved.</p>
                </div>
            </div>
        </footer>
    );
};

export default Footer;
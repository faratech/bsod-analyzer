import React from 'react';
import { Link } from 'react-router-dom';
import SEO from '../components/SEO';

const NotFound: React.FC = () => {
    return (
        <>
            <SEO
                title="Page Not Found"
                description="The page you're looking for doesn't exist."
                noindex={true}
            />
            <main className="page-content">
                <div className="container" style={{ textAlign: 'center', padding: '6rem 1.5rem' }}>
                    <h1 style={{ fontSize: '4rem', marginBottom: '1rem', color: 'var(--text-tertiary)' }}>404</h1>
                    <h2 style={{ marginBottom: '1.5rem' }}>Page Not Found</h2>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem', maxWidth: '500px', margin: '0 auto 2rem' }}>
                        The page you're looking for doesn't exist or has been moved.
                    </p>
                    <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
                        <Link to="/" className="btn btn-primary">
                            Go Home
                        </Link>
                        <Link to="/analyzer" className="btn btn-secondary">
                            Analyze a Dump File
                        </Link>
                    </div>
                </div>
            </main>
        </>
    );
};

export default NotFound;

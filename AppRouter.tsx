import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import Navigation from './components/Navigation';
import Footer from './components/Footer';
import Home from './pages/Home';
import Analyzer from './pages/Analyzer';
import About from './pages/About';
import Documentation from './pages/Documentation';
import Donate from './pages/Donate';

const AppRouter: React.FC = () => {
    return (
        <HelmetProvider>
            <Router>
                <div className="app">
                    <Navigation />
                    <Routes>
                        <Route path="/" element={<Home />} />
                        <Route path="/analyzer" element={<Analyzer />} />
                        <Route path="/about" element={<About />} />
                        <Route path="/documentation" element={<Documentation />} />
                        <Route path="/donate" element={<Donate />} />
                    </Routes>
                    <Footer />
                </div>
            </Router>
        </HelmetProvider>
    );
};

export default AppRouter;
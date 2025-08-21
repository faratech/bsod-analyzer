import React from 'react';
import { Info, Download, CheckCircle, AlertCircle } from 'lucide-react';

interface SymbolStats {
    downloadedModules: number;
    totalSymbols: number;
    failedModules: number;
    pendingDownloads: number;
}

interface SymbolDownloadProgressProps {
    stats: SymbolStats;
    isVisible?: boolean;
}

export const SymbolDownloadProgress: React.FC<SymbolDownloadProgressProps> = ({ 
    stats, 
    isVisible = true 
}) => {
    if (!isVisible || (stats.downloadedModules === 0 && stats.pendingDownloads === 0)) {
        return null;
    }

    return (
        <div className="symbol-download-progress">
            <div className="symbol-header">
                <Download className="symbol-icon" size={16} />
                <span className="symbol-title">Symbol Resolution</span>
            </div>
            
            <div className="symbol-stats">
                {stats.pendingDownloads > 0 && (
                    <div className="stat-item pending">
                        <div className="stat-spinner" />
                        <span>Downloading symbols...</span>
                    </div>
                )}
                
                {stats.downloadedModules > 0 && (
                    <div className="stat-item success">
                        <CheckCircle size={14} />
                        <span>{stats.downloadedModules} modules ({stats.totalSymbols} symbols)</span>
                    </div>
                )}
                
                {stats.failedModules > 0 && (
                    <div className="stat-item warning">
                        <AlertCircle size={14} />
                        <span>{stats.failedModules} modules unavailable</span>
                    </div>
                )}
            </div>
            
            <div className="symbol-info">
                <Info size={12} />
                <span className="info-text">
                    Downloading public symbols for better stack trace analysis
                </span>
            </div>
        </div>
    );
};

// Styles (add to your CSS file)
const styles = `
.symbol-download-progress {
    background: rgba(59, 130, 246, 0.05);
    border: 1px solid rgba(59, 130, 246, 0.2);
    border-radius: 8px;
    padding: 12px;
    margin: 16px 0;
    font-size: 13px;
    animation: fadeIn 0.3s ease-in;
}

.symbol-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    color: var(--brand-primary);
    font-weight: 600;
}

.symbol-icon {
    animation: pulse 2s infinite;
}

.symbol-stats {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 8px 0;
}

.stat-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 4px;
}

.stat-item.pending {
    background: rgba(251, 191, 36, 0.1);
    color: rgb(251, 191, 36);
}

.stat-item.success {
    background: rgba(16, 185, 129, 0.1);
    color: rgb(16, 185, 129);
}

.stat-item.warning {
    background: rgba(245, 158, 11, 0.1);
    color: rgb(245, 158, 11);
}

.stat-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 1s linear infinite;
}

.symbol-info {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    color: var(--text-secondary);
    font-size: 12px;
}

@keyframes fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
}

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
}

@keyframes spin {
    to { transform: rotate(360deg); }
}
`;

// Export styles for inclusion
export const symbolProgressStyles = styles;
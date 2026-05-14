import React from 'react';

interface StructuredDataProps {
    data: object;
}

const StructuredData: React.FC<StructuredDataProps> = ({ data }) => {
    return (
        <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
                __html: JSON.stringify(data)
                    .replace(/</g, '\\u003c')
                    .replace(/>/g, '\\u003e')
                    .replace(/&/g, '\\u0026'),
            }}
        />
    );
};

export default StructuredData;
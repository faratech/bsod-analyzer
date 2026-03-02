export const SITE_URL = 'https://bsod.windowsforum.com';
export const ORG_URL = 'https://windowsforum.com';

export const IMAGES = {
    ogImage: `${SITE_URL}/og-image.webp`,
    logo: `${ORG_URL}/logo.png`,
    logoHeader: `${SITE_URL}/logo-header.webp`,
};

export const IDS = {
    organization: `${ORG_URL}/#organization`,
    provider: `${SITE_URL}/#provider`,
    website: `${SITE_URL}/#website`,
    webApplication: `${SITE_URL}/#application`,
};

export const ORGANIZATION_ENTITY = {
    "@type": "Organization",
    "@id": IDS.organization,
    "name": "WindowsForum",
    "url": ORG_URL,
    "logo": {
        "@type": "ImageObject",
        "url": IMAGES.logo,
        "@id": `${ORG_URL}/#logo`
    },
    "description": "Leading Windows support community providing expert help and tools",
    "foundingDate": "2009",
    "sameAs": [
        "https://twitter.com/windowsforum",
        "https://github.com/faratech"
    ],
    "contactPoint": {
        "@type": "ContactPoint",
        "contactType": "Technical Support",
        "email": "admin@windowsforum.com",
        "url": `${ORG_URL}/misc/contact`
    }
};

export const PROVIDER_ENTITY = {
    "@type": "Organization",
    "@id": IDS.provider,
    "name": "Fara Technologies LLC"
};

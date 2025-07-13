import { useLocation } from 'react-router-dom';

export const useBreadcrumbs = () => {
    const location = useLocation();
    
    const breadcrumbMap: { [key: string]: string } = {
        '/': 'Home',
        '/analyzer': 'Analyzer',
        '/about': 'About',
        '/documentation': 'Documentation',
        '/donate': 'Donate'
    };

    const generateBreadcrumbs = () => {
        const pathnames = location.pathname.split('/').filter(x => x);
        
        const breadcrumbs = [
            {
                "@type": "ListItem",
                "position": 1,
                "name": "Home",
                "item": "https://bsod.windowsforum.com/"
            }
        ];

        let currentPath = '';
        pathnames.forEach((name, index) => {
            currentPath += `/${name}`;
            breadcrumbs.push({
                "@type": "ListItem",
                "position": index + 2,
                "name": breadcrumbMap[currentPath] || name,
                "item": `https://bsod.windowsforum.com${currentPath}`
            });
        });

        return {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            "itemListElement": breadcrumbs
        };
    };

    return location.pathname === '/' ? null : generateBreadcrumbs();
};
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from './icons';
import { UploadControl } from './upload-control';

// Only implemented, live-data destinations belong in production navigation.
const navigation = [
    ['Photos', '/', 'photos'],
    ['Trips', '/trips', 'trips'],
    ['Albums', '/albums', 'albums'],
    ['Favorites', '/favorites', 'heart'],
];

export function Shell({ children }: { children: React.ReactNode }) {
    const path = usePathname();
    const links = () => navigation.map(([label, url, icon]) => {
        const active = path === url || url !== '/' && path?.startsWith(url + '/');
        return (
            <Link key={url} href={url} className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
                <Icon name={icon} size={18} />
                <span>{label}</span>
            </Link>
        );
    });

    return (
        <div className="app-shell">
            <aside className="sidebar">
                <Link href="/" className="brand">
                    <span className="brand-mark"><Icon name="photos" size={20} /></span>
                    <span>My Gallery</span>
                </Link>
                <nav className="nav-group" aria-label="Library navigation">{links()}</nav>
            </aside>
            <div className="main-column">
                <header className="topbar">
                    <div className="mobile-brand">
                        <span className="brand-mark"><Icon name="photos" size={17} /></span>
                        My Gallery
                    </div>
                    <div className="top-actions"><UploadControl /></div>
                </header>
                <main className="main-content">{children}</main>
            </div>
            <nav className="mobile-nav" aria-label="Main navigation">{links()}</nav>
        </div>
    );
}

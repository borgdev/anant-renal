import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Healthcare Harness',
  description: 'Model-agnostic, hypergraph-native healthcare agent harness',
};

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/cases', label: 'Missed-treatment cases' },
  { href: '/replay', label: 'Replay viewer' },
  { href: '/audit', label: 'Audit ledger' },
  { href: '/qapi', label: 'QAPI board' },
  { href: '/packs', label: 'Pack registry' },
  { href: '/measures', label: 'Measures' },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="hh-header">
          <div className="hh-brand">
            <span className="hh-logo" aria-hidden>■</span>
            <span>Healthcare Harness</span>
          </div>
          <nav className="hh-nav">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="hh-nav-link">{item.label}</Link>
            ))}
          </nav>
        </header>
        <main className="hh-main">{children}</main>
        <footer className="hh-footer">
          <span>zero-trust · audit-verified · replayable</span>
        </footer>
      </body>
    </html>
  );
}

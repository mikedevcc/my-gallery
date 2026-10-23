import type { Metadata } from "next";
import { Shell } from "@/components/shell";
import "./globals.css";
import packageJson from '../package.json';

export const metadata: Metadata = {
    title: "My Gallery — Your moments, beautifully kept",
    description: "A personal home for every photograph and memory.",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body suppressHydrationWarning>
                <Shell appVersion={packageJson.version}>
                    {children}
                </Shell>
            </body>
        </html>
    );
}
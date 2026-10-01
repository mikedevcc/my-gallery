import type { Metadata } from "next";
import { Shell } from "@/components/shell";
import "./globals.css";

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
                <Shell>{children}</Shell>
            </body>
        </html>
    );
}
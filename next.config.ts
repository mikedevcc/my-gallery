import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    output: "standalone",

    outputFileTracingExcludes: {
        "/*": [
            "**/*.test.ts",
            "**/*.test.tsx",
            "**/scripts/testing/**",
            "**/docs/**",
            "**/prisma/**",
            "**/.agents/**",
            "**/.claude/**",
            "**/.cursor/**",
            "**/.devin/**",
            "**/.env",
            "**/.env.*",
        ],
    },

    images: {
        remotePatterns: [
            {
                protocol: "https",
                hostname: "images.unsplash.com",
            },
        ],
    },
};

export default nextConfig;
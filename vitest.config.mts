
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "jsdom",
        include: ["components/**/*.test.tsx"],
        restoreMocks: true,
        clearMocks: true,
    },
    resolve: {
        alias: {
            "@": new URL("./", import.meta.url).pathname,
        },
    },
});


export function restoreMediaSelection(key: string): number[] {
    if (typeof window === "undefined") return [];

    try {
        const stored = window.sessionStorage.getItem(key);
        if (stored === null) return [];

        // Selection restoration is one-time.
        window.sessionStorage.removeItem(key);

        const parsed: unknown = JSON.parse(stored);

        if (!Array.isArray(parsed)) return [];

        return [...new Set(
            parsed.filter(
                (id): id is number =>
                    typeof id === "number" &&
                    Number.isSafeInteger(id) &&
                    id > 0
            )
        )];
    } catch {
        // Storage may be disabled or contain malformed data.
        return [];
    }
}

export function saveMediaSelection(
    key: string,
    mediaIds: number[]
): void {
    if (typeof window === "undefined") return;

    try {
        window.sessionStorage.setItem(
            key,
            JSON.stringify(mediaIds)
        );
    } catch {
        // Saving selection is best-effort. Navigation
        // should still work if storage is unavailable.
    }
}

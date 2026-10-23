
'use client';

import {
    useCallback,
    useSyncExternalStore,
} from 'react';

const STORAGE_EVENT = 'my-gallery:storage-updated';

export function usePersistedGroup<T extends string>(
    storageKey: string,
    defaultValue: T,
    allowedValues: readonly T[]
) {
    const subscribe = useCallback(
        (callback: () => void) => {
            window.addEventListener('storage', callback);
            window.addEventListener(STORAGE_EVENT, callback);

            return () => {
                window.removeEventListener('storage', callback);
                window.removeEventListener(STORAGE_EVENT, callback);
            };
        },
        []
    );

    const getSnapshot = () => {
        try {
            const saved = localStorage.getItem(storageKey);

            if (
                saved !== null &&
                allowedValues.includes(saved as T)
            ) {
                return saved as T;
            }
        } catch {
            // Storage may be unavailable.
        }

        return defaultValue;
    };

    const getServerSnapshot = () => defaultValue;

    const group = useSyncExternalStore(
        subscribe,
        getSnapshot,
        getServerSnapshot
    );

    const setGroup = useCallback(
        (nextValue: T) => {
            if (!allowedValues.includes(nextValue)) {
                return;
            }

            try {
                localStorage.setItem(storageKey, nextValue);

                // Notify subscribers in this tab.
                window.dispatchEvent(
                    new Event(STORAGE_EVENT)
                );
            } catch {
                // Storage may be unavailable.
            }
        },
        [storageKey, allowedValues]
    );

    return [group, setGroup] as const;
}

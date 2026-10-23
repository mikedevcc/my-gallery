
import { useCallback, useState } from "react";

export function useGallerySelection() {
    const [selectedMediaIds, setSelectedMediaIds] = useState<number[]>([]);

    const toggleSelection = useCallback((mediaId: number) => {
        setSelectedMediaIds(current =>
            current.includes(mediaId)
                ? current.filter(id => id !== mediaId)
                : [...current, mediaId]
        );
    }, []);

    const selectAll = useCallback((mediaIds: number[]) => {
        setSelectedMediaIds([...new Set(mediaIds)]);
    }, []);

    const clearSelection = useCallback(() => {
        setSelectedMediaIds([]);
    }, []);

    const reconcileSelection = useCallback((availableIds: number[]) => {
        const available = new Set(availableIds);

        setSelectedMediaIds(current =>
            current.every(id => available.has(id))
                ? current
                : current.filter(id => available.has(id))
        );
    }, []);

    const removeSelected = useCallback((ids: number[]) => {
        const removed = new Set(ids);

        setSelectedMediaIds(current =>
            current.filter(id => !removed.has(id))
        );
    }, []);

    return {
        selectedMediaIds,
        toggleSelection,
        selectAll,
        clearSelection,
        reconcileSelection,
        removeSelected,
    };
}

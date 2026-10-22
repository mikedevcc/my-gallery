'use client';

import {
    useEffect,
    useState,
} from 'react';

import { useBulkMedia } from "../lib/use-bulk-media";
import { BulkMediaFeedback } from "./bulk-media-feedback";
import Image from 'next/image';

type AlbumMediaPickerProps = {
    albumId: number;
    open: boolean;
    onClose: () => void;
};

type LibraryMedia = {
    media_id: number;
    file_name: string;
    file_type: 'IMAGE' | 'VIDEO';
    path: string;
    date_taken: string | null;
    date_imported: string;
    width: number | null;
    height: number | null;
    favorite: boolean;
};

export function AlbumMediaPicker({
    albumId,
    open,
    onClose,
}: AlbumMediaPickerProps) {
    const [media, setMedia] =
        useState<LibraryMedia[]>([]);

    const [selectedMediaIds, setSelectedMediaIds] =
        useState<number[]>([]);

    const [loading, setLoading] =
        useState(false);

    const bulk = useBulkMedia("album-add", albumId);
    const adding = bulk.busy;
    const { available: markAvailable } = bulk;

    const [error, setError] =
        useState<string | null>(null);

    useEffect(() => {
        if (!open) {
            return;
        }

        let active = true;
        const controller = new AbortController();
        async function loadMedia() {
            setLoading(true);
            setError(null);

            try {
                const [
                    libraryResponse,
                    albumResponse,
                ] = await Promise.all([
                    fetch('/api/media?scope=all', { signal: controller.signal, cache: 'no-store' }),
                    fetch(`/api/albums/${albumId}`, { signal: controller.signal, cache: 'no-store' }),
                ]);

                if (!libraryResponse.ok) {
                    throw new Error(
                        `Failed to load media (${libraryResponse.status})`
                    );
                }

                if (!albumResponse.ok) {
                    throw new Error(
                        `Failed to load album (${albumResponse.status})`
                    );
                }

                const library =
                    await libraryResponse.json() as LibraryMedia[];

                const albumData =
                    await albumResponse.json() as {
                        media: LibraryMedia[];
                    };

                const existingIds =
                    new Set(
                        albumData.media.map(
                            item => item.media_id
                        )
                    );

                if (!active) return;
                const available = library.filter(item => !existingIds.has(item.media_id));
                available.forEach(item => markAvailable(item.media_id));
                setMedia(available);
                // Preserve failed/uncertain selection even if refreshed rows disappear.
            }
            catch (error) {
                if (active) setError(
                    error instanceof Error
                        ? error.message
                        : 'Failed to load media'
                );
            }
            finally {
                if (active) setLoading(false);
            }
        }

        void loadMedia();
        return () => { active = false; controller.abort(); };
    }, [
        open,
        albumId,
        markAvailable,
    ]);

    if (!open) {
        return null;
    }

    function toggleMedia(
        mediaId: number
    ) {
        if (adding) return;
        if (!selectedMediaIds.includes(mediaId)) bulk.available(mediaId);
        setSelectedMediaIds(current =>
            current.includes(mediaId)
                ? current.filter(
                    id => id !== mediaId
                )
                : [
                    ...current,
                    mediaId,
                ]
        );
    }

    async function addSelectedMedia() {
        await bulk.run(selectedMediaIds, ids => {
            setSelectedMediaIds(current => current.filter(id => !ids.includes(id)));
            setMedia(current => current.filter(item => !ids.includes(item.media_id)));
        });
    }

    return (
        <div className="album-media-picker-backdrop">
            <div className="album-media-picker">

                <div className="album-media-picker-header">
                    <div>
                        <h2>Add media</h2>
                        <p>
                            Select media to add to this album.
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={onClose}
                        disabled={adding}
                        aria-label="Close"
                    >
                        ×
                    </button>
                </div>

                <div className="album-media-picker-grid">
                    {loading ? (
                        <p>Loading media...</p>
                    ) : error ? (
                        <p className="error">
                            {error}
                        </p>
                    ) : media.length === 0 ? (
                        <p>
                            All available media is already in this album.
                        </p>
                    ) : (
                        media.map(item => {
                            const selected =
                                selectedMediaIds.includes(
                                    item.media_id
                                );

                            return (
                                <button
                                    key={item.media_id}
                                    type="button"
                                    disabled={adding}
                                    className={`album-media-option ${
                                        selected
                                            ? 'selected'
                                            : ''
                                    }`}
                                    onClick={() =>
                                        toggleMedia(
                                            item.media_id
                                        )
                                    }
                                >
                                    <Image
                                        src={`/api/media/${item.media_id}/thumbnail`}
                                        alt={item.file_name}
                                        fill
                                        unoptimized
                                    />

                                    {selected && (
                                        <span className="album-media-check">
                                            ✓
                                        </span>
                                    )}
                                </button>
                            );
                        })
                    )}
                </div>

                <BulkMediaFeedback items={bulk.items} />
                <div className="album-media-picker-footer">
                    <span>
                        {selectedMediaIds.length}{' '}
                        selected
                    </span>

                    <button
                        type="button"
                        onClick={() => {
                            void addSelectedMedia();
                        }}
                        disabled={
                            adding || loading || !!error ||
                            !bulk.canRun(selectedMediaIds)
                        }
                    >
                        {adding
                            ? 'Adding...'
                            : 'Add to album'}
                    </button>
                </div>

            </div>
        </div>
    );
}
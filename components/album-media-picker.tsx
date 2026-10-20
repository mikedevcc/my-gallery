'use client';

import {
    useEffect,
    useState,
} from 'react';

import Image from 'next/image';

type AlbumMediaPickerProps = {
    albumId: number;
    open: boolean;
    onClose: () => void;
    onAdded: () => void;
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
    onAdded,
}: AlbumMediaPickerProps) {
    const [media, setMedia] =
        useState<LibraryMedia[]>([]);

    const [selectedMediaIds, setSelectedMediaIds] =
        useState<number[]>([]);

    const [loading, setLoading] =
        useState(false);

    const [adding, setAdding] =
        useState(false);

    const [error, setError] =
        useState<string | null>(null);

    useEffect(() => {
        if (!open) {
            return;
        }

        async function loadMedia() {
            setLoading(true);
            setError(null);

            try {
                const [
                    libraryResponse,
                    albumResponse,
                ] = await Promise.all([
                    fetch('/api/media?scope=all'),
                    fetch(`/api/albums/${albumId}`),
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

                setMedia(
                    library.filter(
                        item =>
                            !existingIds.has(item.media_id)
                    )
                );

                setSelectedMediaIds([]);
            }
            catch (error) {
                setError(
                    error instanceof Error
                        ? error.message
                        : 'Failed to load media'
                );
            }
            finally {
                setLoading(false);
            }
        }

        void loadMedia();
    }, [
        open,
        albumId,
    ]);

    if (!open) {
        return null;
    }

    function toggleMedia(
        mediaId: number
    ) {
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
        if (selectedMediaIds.length === 0) {
            return;
        }

        setAdding(true);
        setError(null);

        try {
            for (const mediaId of selectedMediaIds) {
                const response =
                    await fetch(
                        `/api/albums/${albumId}/media`,
                        {
                            method: 'POST',
                            headers: {
                                'Content-Type':
                                    'application/json',
                            },
                            body: JSON.stringify({
                                mediaId,
                            }),
                        }
                    );

                if (!response.ok) {
                    const result =
                        await response.json() as {
                            error?: string;
                        };

                    throw new Error(
                        result.error ??
                        `Failed to add media ${mediaId}`
                    );
                }
            }

            setSelectedMediaIds([]);

            onAdded();
            onClose();
        }
        catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Failed to add media'
            );
        }
        finally {
            setAdding(false);
        }
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
                            adding ||
                            selectedMediaIds.length === 0
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
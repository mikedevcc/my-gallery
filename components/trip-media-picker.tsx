'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';

import { Icon } from './icons';


type AvailableMedia = {
    media_id: number;
    file_name: string;
    file_type: 'IMAGE' | 'VIDEO';
    date_taken: string | null;
    width: number | null;
    height: number | null;
};

type TripMediaPickerProps = {
    tripId: number;
    open: boolean;
    onClose: () => void;
    onAdded: () => void;
};


export function TripMediaPicker({
    tripId,
    open,
    onClose,
    onAdded,
}: TripMediaPickerProps) {
    const [media, setMedia] = useState<AvailableMedia[]>([]);

    const [selected, setSelected] = useState<number[]>([]);

    const [loading, setLoading] = useState(false);

    const [adding, setAdding] = useState(false);

    const [error, setError] = useState<string | null>(null);

    function toggleMedia(mediaId: number) {
        setSelected(current =>
            current.includes(mediaId)
                ? current.filter(id => id !== mediaId)
                : [...current, mediaId]
        );
    }

    useEffect(() => {
        if (!open) {
            return;
        }

        async function loadMedia() {
            setLoading(true);
            setError(null);

            try {
                const response =
                    await fetch('/api/media');

                if (!response.ok) {
                    throw new Error(
                        `Failed to load media (${response.status})`
                    );
                }

                const result =
                    await response.json() as AvailableMedia[];

                setMedia(result);
                setSelected([]);
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
    }, [open]);

    async function addSelectedMedia() {
        if (selected.length === 0) {
            return;
        }

        setAdding(true);
        setError(null);

        try {
            for (const mediaId of selected) {
                const response = await fetch(
                    `/api/trips/${tripId}/media`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            mediaId,
                        }),
                    }
                );

                if (!response.ok) {
                    throw new Error(
                        `Failed to add media ${mediaId}`
                    );
                }
            }

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

    if (!open) {
        return null;
    }

    return (
        <div className="trip-media-picker-backdrop">
            <div className="trip-media-picker">

                <div className="trip-media-picker-header">
                    <div>
                        <h2>Add media</h2>
                        <p>
                            Choose media from your library.
                        </p>
                    </div>

                    <button
                        onClick={onClose}
                        aria-label="Close"
                    >
                        <Icon
                            name="close"
                            size={18}
                        />
                    </button>
                </div>

                {loading ? (
                    <p>Loading media...</p>
                ) : error ? (
                    <p>{error}</p>
                ) : media.length === 0 ? (
                    <div className="empty-state">
                        <h2>No available media</h2>
                        <p>
                            All media is already assigned
                            to a trip.
                        </p>
                    </div>
                ) : (
                    <div className="trip-media-picker-grid">
                        {media.map(item => {
                            const isSelected =
                                selected.includes(
                                    item.media_id
                                );

                            return (
                                <button
                                    key={item.media_id}
                                    type="button"
                                    className={
                                        isSelected
                                            ? 'trip-media-option selected'
                                            : 'trip-media-option'
                                    }
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
                                        className="photo-img"
                                    />

                                    {isSelected && (
                                        <span className="trip-media-check">
                                            ✓
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                )}

                <div className="trip-media-picker-footer">
                    <span>
                        {selected.length} selected
                    </span>

                    <button
                        type="button"
                        onClick={addSelectedMedia}
                        disabled={
                            selected.length === 0 ||
                            adding
                        }
                    >
                        {adding
                            ? 'Adding...'
                            : 'Add selected'}
                    </button>
                </div>

            </div>
        </div>
    );
}

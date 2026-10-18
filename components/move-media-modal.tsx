'use client';

import { useEffect, useState } from 'react';

type MoveMediaModalProps = {
    open: boolean;
    sourceTripId: number;
    mediaIds: number[];
    onClose: () => void;
    onMoved: () => void;
};

type Trip = {
    trip_id: number;
    trip_name: string;
    media_count: number;
    cover_media_id: number | null;
};


export function MoveMediaModal({
    open,
    sourceTripId,
    mediaIds,
    onClose,
    onMoved,
}: MoveMediaModalProps) {
    const [trips, setTrips] = useState<Trip[]>([]);
    
    const [targetTripId, setTargetTripId] = useState<number | null>(null);
    
    const [moving, setMoving] = useState(false);

    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) {
            return;
        }

        async function loadTrips() {
            setError(null);
            setTargetTripId(null);

            try {
                const response =
                    await fetch('/api/trips');

                if (!response.ok) {
                    throw new Error(
                        `Failed to load trips (${response.status})`
                    );
                }

                const result = await response.json() as Trip[];

                const availableTrips = result.filter(
                    trip => 
                        trip.trip_id !== sourceTripId
                );

                setTrips(availableTrips);
            }
            catch (error) {
                setError(
                    error instanceof Error
                        ? error.message
                        : 'Failed to load trips'
                );
            }
        }

        void loadTrips();
    }, [open, sourceTripId]);

    async function moveMedia() {
        if (targetTripId === null) {
            return;
        }

        setMoving(true);
        setError(null);

        try {
            const response = await fetch(
                `/api/trips/${sourceTripId}/media`,
                {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        mediaIds,
                        targetTripId,
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
                        `Failed to move media (${response.status})`
                );
            }

            onMoved();
            onClose();
        }
        catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Failed to move media'
            );
        }
        finally {
            setMoving(false);
        }
    }

    if (!open) {
        return null;
    }

    return (
        <div className="move-media-backdrop">
            <div className="move-media-modal">

                <div className="move-media-header">
                    <div>
                        <h2>Move to trip</h2>
                        <p>
                            Move {mediaIds.length}{' '}
                            {mediaIds.length === 1
                                ? 'item'
                                : 'items'}
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={onClose}
                    >
                        ×
                    </button>
                </div>

                <div className="move-media-list">

                    {trips.length === 0 ? (
                        <div className="empty-state">
                            <h2>
                                No other trips
                            </h2>

                            <p>
                                Create another trip before
                                moving media.
                            </p>
                        </div>
                    ) : (
                        trips.map(trip => {
                            const selected =
                                targetTripId ===
                                trip.trip_id;

                            return (
                                <button
                                    key={trip.trip_id}
                                    type="button"
                                    className={
                                        selected
                                            ? 'move-trip-option selected'
                                            : 'move-trip-option'
                                    }
                                    onClick={() =>
                                        setTargetTripId(
                                            trip.trip_id
                                        )
                                    }
                                >
                                    <span>
                                        {trip.trip_name}
                                    </span>

                                    <small>
                                        {trip.media_count}{' '}
                                        {trip.media_count === 1
                                            ? 'item'
                                            : 'items'}
                                    </small>
                                </button>
                            );
                        })
                    )}

                </div>

                {error && (
                    <p className="error">
                        {error}
                    </p>
                )}

                <div className="move-media-footer">
                    <button
                        type="button"
                        onClick={onClose}
                    >
                        Cancel
                    </button>

                    <button
                        type="button"
                        onClick={() => {
                            void moveMedia();
                        }}
                        disabled={
                            targetTripId === null ||
                            moving
                        }
                    >
                        {moving
                            ? 'Moving...'
                            : 'Move'}
                    </button>
                </div>

            </div>
        </div>
    );
}
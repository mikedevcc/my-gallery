'use client';

import { useEffect, useState } from 'react';

type MoveTripMediaModalProps = {
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

type AlbumMediaTransferModalProps = {
    open: boolean;
    sourceAlbumId: number;
    mediaIds: number[];
    operation: 'move' | 'copy';
    onClose: () => void;
    onCompleted: () => void;
};

type Album = {
    album_id: number;
    album_name: string;
    media_count: number;
    cover_media_id: number | null;
};


export function MoveTripMediaModal({
    open,
    sourceTripId,
    mediaIds,
    onClose,
    onMoved,
}: MoveTripMediaModalProps) {
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


export function AlbumMediaTransferModal({
    open,
    sourceAlbumId,
    mediaIds,
    operation,
    onClose,
    onCompleted,
}: AlbumMediaTransferModalProps) {
    const [albums, setAlbums] = useState<Album[]>([]);
    
    const [targetAlbumId, setTargetAlbumId] = useState<number | null>(null);
    
    const [transferring, setTransferring] = useState(false);

    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) {
            return;
        }

        async function loadAlbums() {
            setError(null);
            setTargetAlbumId(null);

            try {
                const response =
                    await fetch('/api/albums');

                if (!response.ok) {
                    throw new Error(
                        `Failed to load albums (${response.status})`
                    );
                }

                const result = await response.json() as Album[];

                const availableAlbums = result.filter(
                    album => 
                        album.album_id !== sourceAlbumId
                );

                setAlbums(availableAlbums);
            }
            catch (error) {
                setError(
                    error instanceof Error
                        ? error.message
                        : 'Failed to load albums'
                );
            }
        }

        void loadAlbums();
    }, [open, sourceAlbumId]);

    async function moveMedia() {
        if (targetAlbumId === null) {
            return;
        }

        setTransferring(true);
        setError(null);

        try {
            const response = await fetch(
                `/api/albums/${sourceAlbumId}/media`,
                {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        mediaIds,
                        targetAlbumId,
                        operation,
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
        
            onCompleted();
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
            setTransferring(false);
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
                        <h2>
                            {operation === 'move'
                                ? 'Move to album'
                                : 'Copy to album'}
                        </h2>
                        <p>
                            {operation === 'move' ? 'Move' : 'Copy'}{' '}
                            {mediaIds.length}{' '}
                            {mediaIds.length === 1 ? 'item' : 'items'}
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

                    {albums.length === 0 ? (
                        <div className="empty-state">
                            <h2>
                                No other albums
                            </h2>

                            <p>
                                Create another album before
                                moving media.
                            </p>
                        </div>
                    ) : (
                        albums.map(album => {
                            const selected =
                                targetAlbumId ===
                                album.album_id;

                            return (
                                <button
                                    key={album.album_id}
                                    type="button"
                                    className={
                                        selected
                                            ? 'move-album-option selected'
                                            : 'move-album-option'
                                    }
                                    onClick={() =>
                                        setTargetAlbumId(
                                            album.album_id
                                        )
                                    }
                                >
                                    <span>
                                        {album.album_name}
                                    </span>

                                    <small>
                                        {album.media_count}{' '}
                                        {album.media_count === 1
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
                            targetAlbumId === null ||
                            transferring
                        }
                    >
                        {transferring
                            ? operation === 'move'
                                ? 'Moving...'
                                : 'Copying...'
                            : operation === 'move'
                                ? 'Move'
                                : 'Copy'}
                    </button>
                </div>

            </div>
        </div>
    );
}
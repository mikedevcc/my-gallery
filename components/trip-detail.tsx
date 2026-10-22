'use client';

import { useEffect, useState } from 'react';

import Image from "next/image";
import Link from "next/link";
import { useRouter } from 'next/navigation';

import { groupMediaByDate } from '@/lib/media-grouping';

import { Icon } from './icons';
import { TripMediaPicker } from './trip-media-picker';
import { MoveTripMediaModal } from './move-media-modal';
import { DeleteMediaModal } from './delete-media-modal';
import { CollectionMenu } from './collection-menu';


type TripRow = {
    trip_id: number;
    trip_name: string;
    cover_media_id: number | null;
};

type TripMediaRow = {
    media_id: number;
    file_name: string;
    file_type: 'IMAGE' | 'VIDEO';
    path: string;
    date_taken: string | null;
    width: number | null;
    height: number | null;
    favorite: boolean;
};

type TripResponse = {
    trip: TripRow;
    media: TripMediaRow[];
};


export function TripDetail({
    tripId,
}: {
    tripId: string;
}) {
    const [data, setData] = useState<TripResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [thumbnailRevision, setThumbnailRevision] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const [mediaPickerOpen, setMediaPickerOpen] = useState(false);

    const [selectedMediaIds, setSelectedMediaIds] =
        useState<number[]>(() => {
            if (typeof window === 'undefined') {
                return [];
            }

            const key = `trip-selection:${tripId}`;
            const stored = sessionStorage.getItem(key);

            if (!stored) {
                return [];
            }

            sessionStorage.removeItem(key);

            try {
                return JSON.parse(stored) as number[];
            }
            catch {
                return [];
            }
        });

    const [moveModalOpen, setMoveModalOpen] = useState(false);
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);

    const [group, setGroup] = useState<'All' | 'Months' | 'Days'>('All');


    const router = useRouter();

    const selectionStorageKey = `trip-selection:${tripId}`;


    function toggleMediaSelection(mediaId: number) {
        setSelectedMediaIds(current =>
            current.includes(mediaId)
                ? current.filter(id => id !== mediaId)
                : [...current, mediaId]
        );
    }


    async function refreshTrip() {
        setError(null);

        try {
            const response =
                await fetch(`/api/trips/${tripId}`);

            if (!response.ok) {
                throw new Error(
                    `Failed to load trip (${response.status})`
                );
            }

            const result = await response.json() as TripResponse;

            setData(result);
        }
        catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Failed to load trip'
            );
        }
    }


    async function removeSelectedFromTrip() {
        if (validSelectedMediaIds.length === 0) {
            return;
        }

        const confirmed = window.confirm(
            `Remove ${validSelectedMediaIds.length} selected item${
                validSelectedMediaIds.length === 1 ? '' : 's'
            } from this trip?`
        );

        if (!confirmed) {
            return;
        }

        try {
            for (const mediaId of validSelectedMediaIds) {
                const response = await fetch(
                    `/api/trips/${trip.trip_id}/media`,
                    {
                        method: 'DELETE',
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
                        `Failed to remove media ${mediaId}`
                    );
                }
            }

            setSelectedMediaIds([]);
            await refreshTrip();
        }
        catch (error) {
            console.error(
                'Failed to remove media from trip:',
                error
            );
        }
    }


    useEffect(() => {
        let version = 0;
        let active = true;
        async function loadTrip() {
            const current = ++version;
            try {
                const response = await fetch(`/api/trips/${tripId}`);

                if (!response.ok) {
                    throw new Error(
                        `Failed to load trip (${response.status})`
                    );
                }

                const result =
                    await response.json() as TripResponse;

                if (active && current === version) { setData(result); setError(null); }
            }
            catch (error) {
                if (active && current === version) setError(
                    error instanceof Error
                        ? error.message
                        : 'Failed to load trip'
                );
            }
            finally {
                if (active && current === version) setLoading(false);
            }
        }

        void loadTrip();
        const updated = () => { setThumbnailRevision(current => current + 1); void loadTrip(); };
        window.addEventListener('media-library-updated', updated);
        return () => { active = false; window.removeEventListener('media-library-updated', updated); };
    }, [tripId]);


    if (loading) {
        return (
            <div className="empty-state">
                <h2>Loading trip...</h2>
            </div>
        );
    }


    if (error || !data) {
        return (
            <div className="empty-state">
                <h2>Unable to load trip</h2>
                <p>{error ?? 'Trip not found'}</p>
            </div>
        );
    }


    const {
        trip,
        media,
    } = data;


    const validSelectedMediaIds =
    selectedMediaIds.filter(
        mediaId =>
            media.some(
                item =>
                    item.media_id === mediaId
            )
    );
    

    const allMediaSelected =
        media.length > 0 &&
        media.every(item =>
            validSelectedMediaIds.includes(
                item.media_id
            )
        );


    const groupedMedia = groupMediaByDate(media, group);


    function toggleSelectAll() {
        if (allMediaSelected) {
            setSelectedMediaIds([]);
            return;
        }

        setSelectedMediaIds(
            media.map(
                item => item.media_id
            )
        );
    }


    async function toggleFavoriteMedia(
        mediaId: number,
        favoriteState: boolean
    ) {
        const response = await fetch(
            `/api/media/${mediaId}`,
            {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    favorite: favoriteState,
                }),
            }
        );

        if (!response.ok) {
            throw new Error(
                `Failed to toggle favorite: ${mediaId}`
            );
        }

        setData(current => {
            if (!current) {
                return current;
            }

            return {
                ...current,
                media: current.media.map(item =>
                    item.media_id === mediaId
                        ? {
                            ...item,
                            favorite: favoriteState,
                        }
                        : item
                ),
            };
        });
    }

    
    async function renameCurrentTrip(
        tripName: string
    ) {
        const response = await fetch(
            `/api/trips/${trip.trip_id}`,
            {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    tripName,
                }),
            }
        );

        if (!response.ok) {
            throw new Error(
                'Failed to rename trip'
            );
        }

        await refreshTrip();
    }

    
    async function deleteCurrentTrip() {
        const confirmed = window.confirm(
            `Delete "${trip.trip_name}"?\n\nThe photos will not be deleted.`
        );

        if (!confirmed) {
            return;
        }
    
        const response = await fetch(
            `/api/trips/${trip.trip_id}`,
            {
                method: 'DELETE',
            }
        );

        if (!response.ok) {
            throw new Error(
                'Failed to delete trip'
            );
        }

        router.push('/trips');
    }


    return (
        <>
            <div className="trip-hero">
                {trip.cover_media_id !== null && (
                    <Image
                        src={`/api/media/${trip.cover_media_id}/thumbnail?v=${thumbnailRevision}`}
                        alt={trip.trip_name}
                        fill
                        unoptimized
                        priority
                    />
                )}
                <div className="trip-hero-shade"/>

                <button
                    type="button"
                    className="trip-back-button"
                    onClick={() => router.back()}
                    aria-label="Go back"
                >
                    <Icon
                        name="back"
                        size={18}
                    />
                    Back
                </button>

                <CollectionMenu
                    type="trip"
                    name={trip.trip_name}
                    onRename={renameCurrentTrip}
                    onDelete={deleteCurrentTrip}
                />

                <div className="trip-hero-content">
                    <div className="hero-eyebrow">
                        <Icon
                            name="places"
                            size={16}
                        />

                        A COLLECTION OF MOMENTS
                    </div>

                    <h1>
                        {trip.trip_name}
                    </h1>

                    <div className="hero-meta">
                        <span>
                            <Icon
                                name="photos"
                                size={16}
                            />

                            {media.length.toLocaleString()}{' '}
                            {media.length === 1
                                ? 'photo'
                                : 'photos'}
                        </span>
                    </div>
                </div>
            </div>


            <div className="trip-controls-wrapper">

                <div className="timeline-controls">
                    <div className="segmented">
                        {['All', 'Months', 'Days'].map(value => (
                            <button
                                key={value}
                                className={
                                    group === value
                                        ? 'selected'
                                        : ''
                                }
                                onClick={() =>
                                    setGroup(
                                        value as
                                            'All' | 'Months' | 'Days'
                                    )
                                }
                            >
                                {value}
                            </button>
                        ))}
                    </div>

                    <button
                        className="trip-add-media"
                        onClick={() =>
                            setMediaPickerOpen(true)
                        }
                    >
                        <Icon
                            name="plus"
                            size={16}
                        />
                        Add media
                    </button>
                </div>

                {validSelectedMediaIds.length > 0 && (
                    <div className="trip-selection-bar">

                        <div className="trip-selection-summary">
                            <span>
                                {validSelectedMediaIds.length} selected
                            </span>

                            <button
                                type="button"
                                className="trip-select-all"
                                onClick={toggleSelectAll}
                            >
                                {allMediaSelected
                                    ? 'Unselect all'
                                    : 'Select all'}
                            </button>
                        </div>

                        <div className="trip-selection-actions">

                            <button
                                type="button"
                                onClick={() => {
                                    void removeSelectedFromTrip();
                                }}
                            >
                                Remove from trip
                            </button>

                            <button
                                type="button"
                                onClick={() => {
                                    setMoveModalOpen(true);
                                }}
                            >
                                Move to trip
                            </button>

                            <button
                                type="button"
                                className="danger"
                                onClick={() => {
                                    setDeleteModalOpen(true);
                                }}
                            >
                                Delete
                            </button>

                        </div>

                    </div>
                )}

            </div>


            <div className="section-heading detail-section">
                <p>
                    {media.length === 0
                        ? 'No media has been added to this trip yet.'
                        : `${media.length} ${
                            media.length === 1
                                ? 'memory'
                                : 'memories'
                        } in this trip`}
                </p>
            </div>


            {media.length === 0 ? (
                <div className="empty-state">
                    <Icon
                        name="photos"
                        size={36}
                    />

                    <h2>No photos yet</h2>

                    <p>
                        Add photos to this trip to see them here.
                    </p>
                </div>
            ) : (
                groupedMedia.map(([title, items]) => (
                    <section
                        className="timeline-section"
                        key={title}
                    >
                        {title !== 'All' && (
                            <div className="section-heading">
                                <div>
                                    <h2>{title}</h2>

                                    <p>
                                        {items.length}{' '}
                                        {items.length === 1
                                            ? 'item'
                                            : 'items'}
                                    </p>
                                </div>
                            </div>
                        )}

                        <div className="photo-grid">
                            {items.map(item => (
                                <div
                                    key={item.media_id}
                                    className={`trip-media-tile ${
                                        validSelectedMediaIds.includes(item.media_id)
                                            ? 'selected'
                                            : ''
                                    }`}
                                >
                                    <Link
                                        href={`/photo/${item.media_id}?tripId=${trip.trip_id}`}
                                        scroll={false}
                                        className="photo-tile"
                                        onClick={() => {
                                            sessionStorage.setItem(
                                                selectionStorageKey,
                                                JSON.stringify(validSelectedMediaIds)
                                            );
                                        }}
                                    >
                                        <Image
                                            src={`/api/media/${item.media_id}/thumbnail?v=${thumbnailRevision}`}
                                            alt={item.file_name}
                                            fill
                                            unoptimized
                                            className="photo-img"
                                        />
                                        
                                        <span className="photo-overlay">
                                            <span>
                                                {item.file_name}
                                            </span>
                                        </span>
                                    </Link>

                                    <button
                                        type="button"
                                        className={
                                            item.favorite
                                                ? 'photo-favorite is-favorite'
                                                : 'photo-favorite'
                                        }
                                        onClick={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            
                                            void toggleFavoriteMedia(
                                                item.media_id, 
                                                !item.favorite,
                                            );
                                        }}
                                    >
                                        <Icon
                                            name="heart"
                                            size={18}
                                        />
                                    </button>

                                    <button
                                        type="button"
                                        className="trip-media-select"
                                        aria-label={`Select ${item.file_name}`}
                                        onClick={() => 
                                            toggleMediaSelection(item.media_id)
                                        }
                                    >
                                        {validSelectedMediaIds.includes(item.media_id)
                                            ? '✓'
                                            : ''}
                                    </button>
                                </div>
                            ))}
                        </div>
                        
                    </section>
                ))
                
            )}

            <TripMediaPicker
                tripId={trip.trip_id}
                open={mediaPickerOpen}
                onClose={() =>
                    setMediaPickerOpen(false)
                }
                onAdded={() => {
                    void refreshTrip();
                }}
            />

            <MoveTripMediaModal
                open={moveModalOpen}
                sourceTripId={trip.trip_id}
                mediaIds={validSelectedMediaIds}
                onClose={() => {
                    setMoveModalOpen(false);
                }}
                onMoved={() => {
                    setSelectedMediaIds([]);
                    void refreshTrip();
                }}
            />

            <DeleteMediaModal
                open={deleteModalOpen}
                mediaIds={validSelectedMediaIds}
                onClose={() => {
                    setDeleteModalOpen(false);
                }}
                onDeleted={() => {
                    setSelectedMediaIds([]);
                    void refreshTrip();
                }}
            />
        </>
    );
}
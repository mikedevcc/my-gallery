'use client';

import {
    useEffect,
    useState,
    useRef,
} from 'react';


import type {
    TripCard,
    AlbumCard,
} from '@/lib/types';
import {
    type GroupMode,
    groupMediaByDate
} from '@/lib/media-grouping';

import {
    LibraryMediaGrid,
    type LibraryMedia,
} from './gallery';
import { TripGrid, AlbumGrid } from './cards';
import { Icon } from './icons';
import { CreateTripModal } from './create-trip-modal';
import { CreateAlbumModal } from './create-album-modal';


type TripApiRow = {
    trip_id: number;
    trip_name: string;
    media_count: number;
    cover_media_id: number | null;
};


type AlbumApiRow = {
    album_id: number;
    album_name: string;
    media_count: number;
    cover_media_id: number | null;
};


export function PhotosPage() {
    const loadVersion = useRef(0);
    const [thumbnailRevision, setThumbnailRevision] = useState(0);
    const [media, setMedia] = useState<LibraryMedia[]>([]);

    const [loading, setLoading] = useState(true);

    const [error, setError] = useState<string | null>(null);

    const density = 'comfortable';

    const [group, setGroup] = useState<GroupMode>('Months');


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

        setMedia(current =>
            current.map(item =>
                item.media_id === mediaId
                    ? {
                        ...item,
                        favorite: favoriteState,
                    }
                    : item
            )
        );
    }


    useEffect(() => {
        async function loadMedia() {
            const version = ++loadVersion.current;
            try {
                const response = await fetch('/api/media?scope=all');

                if (!response.ok) {
                    throw new Error(
                        `Failed to load library (${response.status})`
                    );
                }

                const result = await response.json() as LibraryMedia[];

                if (version === loadVersion.current) { setMedia(result); setError(null); }
            }
            catch (error) {
                if (version === loadVersion.current) setError(
                    error instanceof Error
                        ? error.message
                        : 'Failed to load library'
                );
            }
            finally {
                if (version === loadVersion.current) setLoading(false);
            }
        }

        void loadMedia();
    }, []);


    useEffect(() => {
        function handleLibraryUpdated() {
            setThumbnailRevision(current => current + 1);
            async function reloadMedia() {
                const version = ++loadVersion.current;
                try {
                    const response =
                        await fetch(
                            '/api/media?scope=all'
                        );

                    if (!response.ok) {
                        return;
                    }

                    const result =
                        await response.json() as LibraryMedia[];

                    if (version === loadVersion.current) { setMedia(result); setError(null); }
                }
                catch (error) {
                    console.error(
                        'Failed to refresh library:',
                        error
                    );
                }
                finally { if (version === loadVersion.current) setLoading(false); }
            }

            void reloadMedia();
        }

        window.addEventListener(
            'media-library-updated',
            handleLibraryUpdated
        );

        return () => {
            window.removeEventListener(
                'media-library-updated',
                handleLibraryUpdated
            );
        };
    }, []);

    
    const groupedSections = groupMediaByDate(media, group);

    if (loading) {
        return (
            <div className="empty-state">
                <h2>Loading library...</h2>
            </div>
        );
    }


    if (error) {
        return (
            <div className="empty-state">
                <h2>
                    Unable to load library
                </h2>

                <p>{error}</p>
            </div>
        );
    }


    return (
        <>
            <div className="eyebrow">
                <Icon
                    name="sparkle"
                    size={15}
                />
                YOUR LIBRARY
                <span className="eyebrow-line"/>
            </div>


            <div className="page-heading home-heading">
                <div>
                    <h1>Photos</h1>

                    <p>
                        Your memories, one moment at a time.
                    </p>
                </div>
            </div>


            <div className="timeline-controls">
                <div
                    className="segmented"
                    aria-label="Group media by"
                >
                    {[
                        'All',
                        'Years',
                        'Months',
                        'Days',
                    ].map(value => (
                        <button
                            key={value}
                            onClick={() =>
                                setGroup(
                                    value as
                                        'All' |
                                        'Years' |
                                        'Months' |
                                        'Days'
                                )
                            }
                            className={
                                group === value
                                    ? 'selected'
                                    : ''
                            }
                        >
                            {value}
                        </button>
                    ))}
                </div>

                <span className="photo-total">
                    {media.length.toLocaleString()}{' '}
                    {media.length === 1
                        ? 'memory'
                        : 'memories'}
                </span>
            </div>


            {media.length === 0 ? (
                <EmptyState
                    title="No media yet"
                    text="Import some photos or videos to start your library."
                />
            ) : (
                groupedSections.map(
                    ([title, items]) => (
                        <section
                            className="timeline-section"
                            key={title}
                        >
                            <div className="section-heading">
                                <div>
                                    <h2>
                                        {title}
                                    </h2>

                                    <p>
                                        {items.length}{' '}
                                        {items.length === 1
                                            ? 'item'
                                            : 'items'}
                                    </p>
                                </div>
                            </div>

                            <LibraryMediaGrid
                                revision={thumbnailRevision}
                                items={items}
                                density={density}
                                onToggleFavorite={toggleFavoriteMedia}
                            />
                        </section>
                    )
                )
            )}
        </>
    );
}


export function TripsPage() {
    const loadVersion = useRef(0);
    const [thumbnailRevision, setThumbnailRevision] = useState(0);
    const [trips, setTrips] = useState<TripApiRow[]>([]);

    const [loading, setLoading] = useState(true);

    const [createTripOpen, setCreateTripOpen] = useState(false);


    async function loadTrips() {
        const version = ++loadVersion.current;
        try {
            const response = await fetch('/api/trips');

            if (!response.ok) {
                throw new Error(
                    'Failed to load trips'
                );
            }

            const data = await response.json() as TripApiRow[];

            if (version === loadVersion.current) setTrips(data);
        }
        catch (error) {
            console.error(
                'Failed to load trips:',
                error
            );
        }
        finally {
            if (version === loadVersion.current) setLoading(false);
        }
    }


    useEffect(() => {
        async function initialLoad() {
            await loadTrips();
        }

        void initialLoad();
        const updated = () => { setThumbnailRevision(current => current + 1); void loadTrips(); };
        window.addEventListener('media-library-updated', updated);
        return () => window.removeEventListener('media-library-updated', updated);
    }, []);


    const tripCards: TripCard[] =
        trips.map(trip => ({
            id: trip.trip_id,
            slug: String(trip.trip_id),
            name: trip.trip_name,
            count: trip.media_count,
            cover:
                trip.cover_media_id !== null
                    ? `/api/media/${trip.cover_media_id}/thumbnail?v=${thumbnailRevision}`
                    : undefined,
        }));


    if (loading) {
        return <p>Loading trips...</p>;
    }


    return (
        <>
            <PageHeading
                eyebrow="THE JOURNEY"
                title="Trips"
                subtitle="Your journeys, beautifully organized"
                action="New Trip"
                onAction={() => {
                    setCreateTripOpen(true);
                }}
            />

            {tripCards.length === 0 ? (
                <EmptyState
                    title="No trips yet"
                    text="Create trips to revisit your jounreys."
                />
            ) : (
                <TripGrid items={tripCards}/>
            )}

            <CreateTripModal
                open={createTripOpen}
                onClose={() => {
                    setCreateTripOpen(false);
                }}
                onCreated={() => {
                    void loadTrips();
                }}
            />
        </>
    );
}


export function AlbumsPage() {
    const loadVersion = useRef(0);
    const [thumbnailRevision, setThumbnailRevision] = useState(0);
    const [albums, setAlbums] = useState<AlbumApiRow[]>([]);

    const [loading, setLoading] = useState(true);

    const [createAlbumOpen, setCreateAlbumOpen] = useState(false);


    async function loadAlbums() {
        const version = ++loadVersion.current;
        try {
            const response = await fetch('/api/albums');

            if (!response.ok) {
                throw new Error(
                    'Failed to load albums'
                );
            }

            const data = await response.json() as AlbumApiRow[];

            if (version === loadVersion.current) setAlbums(data);
        }
        catch (error) {
            console.error(
                'Failed to load albums:',
                error
            );
        }
        finally {
            if (version === loadVersion.current) setLoading(false);
        }
    }


    useEffect(() => {
        async function initialLoad() {
            await loadAlbums();
        }

        void initialLoad();
        const updated = () => { setThumbnailRevision(current => current + 1); void loadAlbums(); };
        window.addEventListener('media-library-updated', updated);
        return () => window.removeEventListener('media-library-updated', updated);
    }, []);


    const albumCards: AlbumCard[] =
        albums.map(album => ({
            id: album.album_id,
            slug: String(album.album_id),
            name: album.album_name,
            count: album.media_count,
            cover:
                album.cover_media_id !== null
                    ? `/api/media/${album.cover_media_id}/thumbnail?v=${thumbnailRevision}`
                    : undefined,
        }));


    if (loading) {
        return <p>Loading albums...</p>;
    }


    return (
        <>
            <PageHeading
                eyebrow="YOUR COLLECTIONS"
                title="Albums"
                subtitle="Organize your favorite moments into collections"
                action="New Album"
                onAction={() => {
                    setCreateAlbumOpen(true);
                }}
            />

            {albumCards.length === 0 ? (
                <EmptyState
                    title="No albums yet"
                    text="Create an album to organize your media."
                />
            ) : (
                <AlbumGrid items={albumCards}/>
            )}

            <CreateAlbumModal
                open={createAlbumOpen}
                onClose={() => {
                    setCreateAlbumOpen(false);
                }}
                onCreated={() => {
                    void loadAlbums();
                }}
            />
        </>
    );
}


export function FavoritesPage() {
    const loadVersion = useRef(0);
    const [thumbnailRevision, setThumbnailRevision] = useState(0);
    const [media, setMedia] = useState<LibraryMedia[]>([]);

    const [loading, setLoading] = useState(true);

    const [error, setError] = useState<string | null>(null);

    const [group, setGroup] = useState<GroupMode>('All');


    async function reloadMedia() {
        const version = ++loadVersion.current;
        try {
            const response =
                await fetch(
                    '/api/media?scope=all'
                );

            if (!response.ok) {
                return;
            }

            const result =
                await response.json() as LibraryMedia[];

            if (version === loadVersion.current) {
                setMedia(result.filter(item => item.favorite === true));
                setError(null);
            }
        }
        catch (error) {
            console.error(
                'Failed to refresh library:',
                error
            );
        }
        finally { if (version === loadVersion.current) setLoading(false); }
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

        setMedia(current =>
            current
                .map(item =>
                    item.media_id === mediaId
                        ? {
                            ...item,
                            favorite: favoriteState,
                        }
                        : item
                )
                .filter(item => item.favorite)
        );
    }


    useEffect(() => {
        async function loadMedia() {
            const version = ++loadVersion.current;
            try {
                const response = await fetch('/api/media?scope=all');

                if (!response.ok) {
                    throw new Error(
                        `Failed to load library (${response.status})`
                    );
                }

                const result = await response.json() as LibraryMedia[];

                if (version === loadVersion.current) {
                    setMedia(result.filter(item => item.favorite === true));
                    setError(null);
                }
            }
            catch (error) {
                if (version === loadVersion.current) setError(
                    error instanceof Error
                        ? error.message
                        : 'Failed to load library'
                );
            }
            finally {
                if (version === loadVersion.current) setLoading(false);
            }
        }

        void loadMedia();
    }, []);


    useEffect(() => {
        function handleLibraryUpdated() {
            setThumbnailRevision(current => current + 1);
            

            void reloadMedia();
        }

        window.addEventListener(
            'media-library-updated',
            handleLibraryUpdated
        );

        return () => {
            window.removeEventListener(
                'media-library-updated',
                handleLibraryUpdated
            );
        };
    }, []);


    const groupedSections = groupMediaByDate(media, group);

    if (loading) {
        return (
            <div className="empty-state">
                <h2>Loading Favorites...</h2>
            </div>
        );
    }


    if (error) {
        return (
            <div className="empty-state">
                <h2>
                    Unable to load favorites
                </h2>

                <p>{error}</p>
            </div>
        );
    }


    return (
        <>
            <PageHeading 
                eyebrow="CLOSE TO HEART"
                title="Favorites"
                subtitle="The moments you love most"
            />

            <div className="timeline-controls">
                <div
                    className="segmented"
                    aria-label="Group media by"
                >
                    {[
                        'All',
                        'Years',
                        'Months',
                        'Days',
                    ].map(value => (
                        <button
                            key={value}
                            onClick={() =>
                                setGroup(
                                    value as
                                        'All' |
                                        'Years' |
                                        'Months' |
                                        'Days'
                                )
                            }
                            className={
                                group === value
                                    ? 'selected'
                                    : ''
                            }
                        >
                            {value}
                        </button>
                    ))}
                </div>

                <span className="photo-total">
                    {media.length.toLocaleString()}{' '}
                    {media.length === 1
                        ? 'memory'
                        : 'memories'}
                </span>
            </div>

            {media.length === 0 ? (
                <EmptyState
                    title="No favorites yet"
                    text="Favorite photos or videos to see them here."
                />
            ) : (
                groupedSections.map(
                    ([title, items]) => (
                        <section
                            className="timeline-section"
                            key={title}
                        >
                            <div className="section-heading">
                                <div>
                                    <h2>
                                        {title}
                                    </h2>

                                    <p>
                                        {items.length}{' '}
                                        {items.length === 1
                                            ? 'item'
                                            : 'items'}
                                    </p>
                                </div>
                            </div>

                            <LibraryMediaGrid
                                revision={thumbnailRevision}
                                items={items}
                                onToggleFavorite={toggleFavoriteMedia}
                            />
                        </section>
                    )
                )
            )}
        </>
    )
}


function PageHeading({
    eyebrow,
    title,
    subtitle,
    action,
    onAction,
}:{
    eyebrow: string;
    title: string;
    subtitle: string;
    action?: string;
    onAction?: () => void;
}) {
    return (
        <>
            <div className="eyebrow">
                <Icon name="sparkle" size={15}/>
                {eyebrow}
                <span className="eyebrow-line"/>
            </div>

            <div className="page-heading">
                <div>
                    <h1>{title}</h1>
                    <p>{subtitle}</p>
                </div>

                {action && (
                    <button
                        className="outline-action"
                        onClick={onAction}
                    >
                        <Icon name="plus" size={17}/>
                        {action}
                    </button>
                )}
            </div>
        </>
    );
}


function EmptyState({
    title,
    text,
}: {
    title: string;
    text: string;
}) {
    return (
        <div className="empty-state">
            <h2>{title}</h2>
            <p>{text}</p>
        </div>
    );
}
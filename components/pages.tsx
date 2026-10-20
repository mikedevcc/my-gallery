'use client';

import {
    useEffect,
    useState,
} from 'react';

import { useSearchParams } from 'next/navigation';

import type {
    TripCard,
    AlbumCard,
} from '@/lib/types';
import { albums, photos, trips } from '@/lib/mock-data';
import {
    type GroupMode,
    groupMediaByDate
} from '@/lib/media-grouping';

import {
    LibraryMediaGrid,
    type LibraryMedia,
    PhotoGrid,
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
    const [media, setMedia] = useState<LibraryMedia[]>([]);

    const [loading, setLoading] = useState(true);

    const [error, setError] = useState<string | null>(null);

    const [density, setDensity] = useState('comfortable');

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
            try {
                const response = await fetch('/api/media?scope=all');

                if (!response.ok) {
                    throw new Error(
                        `Failed to load library (${response.status})`
                    );
                }

                const result = await response.json() as LibraryMedia[];

                setMedia(result);
            }
            catch (error) {
                setError(
                    error instanceof Error
                        ? error.message
                        : 'Failed to load library'
                );
            }
            finally {
                setLoading(false);
            }
        }

        void loadMedia();
    }, []);


    useEffect(() => {
        function handleLibraryUpdated() {
            async function reloadMedia() {
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

                    setMedia(result);
                }
                catch (error) {
                    console.error(
                        'Failed to refresh library:',
                        error
                    );
                }
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
                        'Years',
                        'Months',
                        'Days',
                    ].map(value => (
                        <button
                            key={value}
                            onClick={() =>
                                setGroup(
                                    value as
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
    const [trips, setTrips] = useState<TripApiRow[]>([]);

    const [loading, setLoading] = useState(true);

    const [createTripOpen, setCreateTripOpen] = useState(false);


    async function loadTrips() {
        try {
            const response = await fetch('/api/trips');

            if (!response.ok) {
                throw new Error(
                    'Failed to load trips'
                );
            }

            const data = await response.json() as TripApiRow[];

            setTrips(data);
        }
        catch (error) {
            console.error(
                'Failed to load trips:',
                error
            );
        }
        finally {
            setLoading(false);
        }
    }


    useEffect(() => {
        async function initialLoad() {
            await loadTrips();
        }

        void initialLoad();
    }, []);


    const tripCards: TripCard[] =
        trips.map(trip => ({
            id: trip.trip_id,
            slug: String(trip.trip_id),
            name: trip.trip_name,
            count: trip.media_count,
            cover:
                trip.cover_media_id !== null
                    ? `/api/media/${trip.cover_media_id}/thumbnail`
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
    const [albums, setAlbums] = useState<AlbumApiRow[]>([]);

    const [loading, setLoading] = useState(true);

    const [createAlbumOpen, setCreateAlbumOpen] = useState(false);


    async function loadAlbums() {
        try {
            const response = await fetch('/api/albums');

            if (!response.ok) {
                throw new Error(
                    'Failed to load albums'
                );
            }

            const data = await response.json() as AlbumApiRow[];

            setAlbums(data);
        }
        catch (error) {
            console.error(
                'Failed to load albums:',
                error
            );
        }
        finally {
            setLoading(false);
        }
    }


    useEffect(() => {
        async function initialLoad() {
            await loadAlbums();
        }

        void initialLoad();
    }, []);


    const albumCards: AlbumCard[] =
        albums.map(album => ({
            id: album.album_id,
            slug: String(album.album_id),
            name: album.album_name,
            count: album.media_count,
            cover:
                album.cover_media_id !== null
                    ? `/api/media/${album.cover_media_id}/thumbnail`
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


export function FavoritesPage(){return <><PageHeading eyebrow="CLOSE TO HEART" title="Favorites" subtitle="The moments you love most"/><PhotoGrid items={photos.filter(p=>p.favorite)}/></>}
export function SearchPage(){const params=useSearchParams();const initial=params.get('q')||'';const [query,setQuery]=useState(initial);const [filter,setFilter]=useState('All');const q=query.toLowerCase().trim();const result=photos.filter(p=>!q||[p.title,p.location?.city,p.location?.country,...p.tags,p.camera?.model].some(s=>s?.toLowerCase().includes(q)));return <><PageHeading eyebrow="DISCOVER" title="Search" subtitle="Find any trip, moment, or memory"/><div className="search-hero"><Icon name="search" size={24}/><input aria-label="Search library" autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search photos, trips, or anything..."/><span>↵</span></div><div className="filter-row">{['All','Photos','Trips','Albums','Videos'].map(f=><button key={f} className={filter===f?'active':''} onClick={()=>setFilter(f)}>{f}</button>)}</div>{!q&&<div className="suggestions"><span>TRY SEARCHING FOR</span>{['Kyoto temples','Singapore','Sony A7 III','Nature','Iceland'].map(s=><button key={s} onClick={()=>setQuery(s)}><Icon name="search" size={14}/>{s}</button>)}</div>}<div className="results-heading"><h2>{q?`Results for “${query}”`:'Explore your library'}</h2><span>{filter==='All'||filter==='Photos'?result.length:filter==='Trips'?trips.length:filter==='Albums'?albums.length:0} results</span></div>{filter==='Trips'?<TripGrid items={trips.filter(t=>!q||t.name.toLowerCase().includes(q)||t.places.toLowerCase().includes(q))}/>:filter==='Albums'?<AlbumGrid items={albums.filter(a=>!q||a.name.toLowerCase().includes(q))}/>:filter==='Videos'?<EmptyState title="No videos yet" text="Videos will appear here when your library is connected."/>:result.length?<PhotoGrid items={result}/>:<EmptyState title="No matches found" text="Try another trip, subject, or camera name."/>}</>}
export function SimplePage({kind}:{kind:'Recently Added'|'Videos'|'Screenshots'|'Trash'}){const items=kind==='Recently Added'?photos.slice(0,8):[];return <><PageHeading eyebrow="YOUR LIBRARY" title={kind} subtitle={kind==='Recently Added'?'The newest moments in your library':`${kind} in your library`}/>{items.length?<PhotoGrid items={items}/>:<EmptyState title={`No ${kind.toLowerCase()} yet`} text="Your collection will appear here when your library is connected."/>}</>}


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
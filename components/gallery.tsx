'use client';

import { formatCaptureDate } from "../lib/media-capture-date";
import Image from 'next/image';
import Link from 'next/link';
import {
    useRouter,
    useSearchParams,
} from 'next/navigation';
import {
    useEffect,
    useState,
    useSyncExternalStore,
} from 'react';


import { Icon } from './icons';


type MediaDetails = {
    media_id: number;
    file_name: string;
    file_type: 'IMAGE' | 'VIDEO';
    file_size: number;
    path: string;
    date_taken: string | null;
    capture_local?: string | null;
    capture_offset_minutes?: number | null;
    width: number | null;
    height: number | null;
    favorite: boolean;

    city_name: string | null;
    country_name: string | null;

    aperture: number | null;
    iso: number | null;
    exposure_time: number | null;
    focal_length_mm: number | null;
    focal_length_35mm: number | null;
    flash: string | null;
    white_balance: string | null;

    duration_seconds: number | null;
    frame_rate: number | null;
    video_codec: string | null;
    audio_codec: string | null;
    bitrate: number | null;
};

type TripMediaRow = {
    media_id: number;
    file_name: string;
    file_type: 'IMAGE' | 'VIDEO';
    path: string;
    date_taken: string | null;
    capture_local?: string | null;
    capture_offset_minutes?: number | null;
    width: number | null;
    height: number | null;
    favorite: boolean;
};

type TripResponse = {
    trip: {
        trip_id: number;
        trip_name: string;
        cover_media_id: number | null;
    };

    media: TripMediaRow[];
};

export type LibraryMedia = {
    media_id: number;
    file_name: string;
    file_type: 'IMAGE' | 'VIDEO';
    date_taken: string | null;
    capture_local?: string | null;
    capture_offset_minutes?: number | null;
    date_imported: string;
    width: number | null;
    height: number | null;
    favorite: boolean;
    city_name: string | null;
    country_name: string | null;
};


export function Viewer({
    id,
}: {
    id: string;
}) {
    const router = useRouter();
    const searchParams = useSearchParams();

    const tripId = searchParams.get('tripId');

    const [media, setMedia] =
        useState<MediaDetails | null>(null);

    const [tripMedia, setTripMedia] =
        useState<TripMediaRow[]>([]);

    const [loading, setLoading] =
        useState(true);

    const [error, setError] =
        useState<string | null>(null);

    const [info, setInfo] =
        useState(true);

    const [favorite, setFavorite] =
        useState(false);

    const canShare = useSyncExternalStore(
        () => () => {},
        () => typeof navigator.share === 'function',
        () => false,
    );
    const [shareError, setShareError] = useState('');

    useEffect(() => {
        async function loadMedia() {
            setLoading(true);
            setError(null);

            try {
                const response =
                    await fetch(`/api/media/${id}`);

                if (!response.ok) {
                    throw new Error(
                        `Failed to load media (${response.status})`
                    );
                }

                const result =
                    await response.json() as MediaDetails;

                setMedia(result);
                setFavorite(result.favorite);
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
    }, [id]);


    useEffect(() => {
        if (tripId === null) {
            return;
        }

        async function loadTripMedia() {
            try {
                const response =
                    await fetch(`/api/trips/${tripId}`);

                if (!response.ok) {
                    return;
                }

                const result =
                    await response.json() as TripResponse;

                setTripMedia(result.media);
            }
            catch (error) {
                console.error(
                    'Failed to load trip media:',
                    error
                );
            }
        }

        void loadTripMedia();
    }, [tripId]);

    
    const activeTripMedia =
    tripId === null
        ? []
        : tripMedia;


    useEffect(() => {
        document.body.style.overflow = 'hidden';

        return () => {
            document.body.style.overflow = '';
        };
    }, []);


    const currentIndex =
        activeTripMedia.findIndex(
            item =>
                item.media_id === Number(id)
        );


    function openMedia(mediaId: number) {
        const query =
            tripId !== null
                ? `?tripId=${tripId}`
                : '';

        router.replace(
            `/photo/${mediaId}${query}`,
            {
                scroll: false,
            }
        );
    }


    function move(direction: number) {
        if (
            activeTripMedia.length === 0 ||
            currentIndex === -1
        ) {
            return;
        }

        const nextIndex =
            (
                currentIndex +
                direction +
                activeTripMedia.length
            ) % activeTripMedia.length;

        openMedia(
            activeTripMedia[nextIndex].media_id
        );
    }


    useEffect(() => {
        function handleKeyDown(
            event: KeyboardEvent
        ) {
            if (event.key === 'Escape') {
                router.back();
            }

            if (
                event.key === 'ArrowRight' &&
                activeTripMedia.length > 1
            ) {
                move(1);
            }

            if (
                event.key === 'ArrowLeft' &&
                activeTripMedia.length > 1
            ) {
                move(-1);
            }

            if (
                (event.ctrlKey ||
                    event.metaKey) &&
                event.key.toLowerCase() === 'i'
            ) {
                event.preventDefault();

                setInfo(
                    current => !current
                );
            }
        }

        window.addEventListener(
            'keydown',
            handleKeyDown
        );

        return () => {
            window.removeEventListener(
                'keydown',
                handleKeyDown
            );
        };
    });


    function back() {
        if (window.history.length > 1) {
            router.back();
        }
        else {
            router.push('/');
        }
    }


    if (loading) {
        return (
            <div
                className="viewer"
                role="dialog"
                aria-modal="true"
            >
                <div className="empty-state">
                    <h2>Loading media...</h2>
                </div>
            </div>
        );
    }


    if (error || !media) {
        return (
            <div
                className="viewer"
                role="dialog"
                aria-modal="true"
            >
                <div className="empty-state">
                    <h2>
                        Unable to load media
                    </h2>

                    <p>
                        {error ??
                            'Media not found'}
                    </p>

                    <button
                        onClick={back}
                    >
                        Go back
                    </button>
                </div>
            </div>
        );
    }


    const position =
        currentIndex >= 0
            ? currentIndex + 1
            : 1;

    const total =
        activeTripMedia.length > 0
            ? activeTripMedia.length
            : 1;


    const fileUrl =
        `/api/media/${media.media_id}/file`;

    const thumbnailUrl =
        `/api/media/${media.media_id}/thumbnail`;


    async function toggleViewerFavorite() {
        if (!media) {
            return;
        }

        const nextFavoriteState = !favorite;

        const response = await fetch(
            `/api/media/${media.media_id}`,
            {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    favorite: nextFavoriteState,
                }),
            }
        );

        if (!response.ok) {
            throw new Error(
                `Failed to toggle favorite: ${media.media_id}`
            );
        }

        setFavorite(nextFavoriteState);

        window.dispatchEvent(
            new Event('media-library-updated')
        );
    }


    return (
        <div
            className="viewer"
            role="dialog"
            aria-modal="true"
            aria-label={`Media viewer: ${media.file_name}`}
        >
            <div className="viewer-main">

                <div className="viewer-toolbar">

                    <div className="viewer-toolbar-group">

                        <button
                            className="viewer-icon"
                            onClick={back}
                            aria-label="Close viewer"
                        >
                            <Icon name="back"/>
                        </button>

                        <span className="viewer-count">
                            {position}
                            {' '}
                            <span>/</span>
                            {' '}
                            {total}
                        </span>

                        <span className="viewer-filename">
                            {media.file_name}
                        </span>

                    </div>


                    <div className="viewer-toolbar-group">

                        <button
                            className={`viewer-icon ${
                                favorite
                                    ? 'liked'
                                    : ''
                            }`}
                            aria-label="Toggle favorite"
                            onClick={() => {
                                void toggleViewerFavorite();
                            }}
                        >
                            <Icon name="heart"/>
                        </button>


                        {canShare && (
                            <button
                                className="viewer-icon"
                                aria-label="Share media"
                                onClick={async () => {
                                    setShareError('');
                                    try {
                                        await navigator.share({ title: media.file_name, url: window.location.href });
                                    } catch (error) {
                                        if (!(error instanceof Error && error.name === 'AbortError')) {
                                            setShareError('Sharing failed. You can download the original to share it.');
                                        }
                                    }
                                }}
                            >
                                <Icon name="share"/>
                            </button>
                        )}

                        <a
                            className="viewer-icon"
                            aria-label="Download media"
                            href={fileUrl}
                            download={
                                media.file_name
                            }
                        >
                            <Icon name="download"/>
                        </a>


                        <button
                            className="viewer-icon"
                            aria-label="Toggle information"
                            onClick={() =>
                                setInfo(
                                    current =>
                                        !current
                                )
                            }
                        >
                            <Icon name="info"/>
                        </button>


                        <button
                            className="viewer-icon close-viewer"
                            aria-label="Close"
                            onClick={back}
                        >
                            <Icon name="close"/>
                        </button>

                    </div>

                </div>


                {shareError && <p role="alert">{shareError}</p>}

                <div className="viewer-stage">

                    {activeTripMedia.length > 1 && (
                        <button
                            className="viewer-arrow left"
                            aria-label="Previous media"
                            onClick={() =>
                                move(-1)
                            }
                        >
                            <Icon
                                name="back"
                                size={25}
                            />
                        </button>
                    )}


                    {media.file_type ===
                    'IMAGE' ? (
                        <Image
                            src={fileUrl}
                            alt={
                                media.file_name
                            }
                            fill
                            sizes="100vw"
                            unoptimized
                            className="viewer-image"
                        />
                    ) : (
                        <video
                            src={fileUrl}
                            controls
                            playsInline
                            poster={
                                thumbnailUrl
                            }
                            style={{
                                width: '100%',
                                height: '100%',
                                objectFit:
                                    'contain',
                            }}
                        />
                    )}


                    {activeTripMedia.length > 1 && (
                        <button
                            className="viewer-arrow right"
                            aria-label="Next media"
                            onClick={() =>
                                move(1)
                            }
                        >
                            <Icon
                                name="chevron"
                                size={25}
                            />
                        </button>
                    )}

                </div>


                {activeTripMedia.length > 0 && (
                    <div
                        className="filmstrip"
                        aria-label="Media thumbnails"
                    >
                        {activeTripMedia.map(
                            item => {
                                const selected =
                                    item.media_id ===
                                    media.media_id;

                                return (
                                    <button
                                        key={
                                            item.media_id
                                        }
                                        className={`film-thumb ${
                                            selected
                                                ? 'selected'
                                                : ''
                                        }`}
                                        onClick={() =>
                                            openMedia(
                                                item.media_id
                                            )
                                        }
                                        aria-label={`View ${item.file_name}`}
                                        aria-current={
                                            selected
                                                ? 'true'
                                                : undefined
                                        }
                                    >
                                        <Image
                                            src={`/api/media/${item.media_id}/thumbnail`}
                                            alt=""
                                            fill
                                            sizes="72px"
                                            unoptimized
                                        />
                                    </button>
                                );
                            }
                        )}
                    </div>
                )}

            </div>


            {info && (
                <aside className="info-panel">

                    <div className="info-heading">

                        <div>
                            <h2>Info</h2>

                            <span>
                                Details of this moment
                            </span>
                        </div>

                        <button
                            onClick={() =>
                                setInfo(false)
                            }
                            aria-label="Close information"
                        >
                            <Icon
                                name="close"
                                size={18}
                            />
                        </button>

                    </div>


                    <div className="info-content">

                        <h3>
                            {media.file_name}
                        </h3>


                        {(media.city_name ||
                            media.country_name) && (
                            <p className="info-location">
                                {media.city_name}

                                {media.city_name &&
                                media.country_name
                                    ? ', '
                                    : ''}

                                {media.country_name}
                            </p>
                        )}


                        <div className="info-row">

                            <Icon name="calendar"/>

                            <span>
                                {formatCaptureDate(media)}
                            </span>

                        </div>


                        <div className="info-row">

                            <Icon name="info"/>

                            <span>
                                {media.width ??
                                    '?'}
                                {' × '}
                                {media.height ??
                                    '?'}

                                <small>
                                    {formatFileSize(
                                        media.file_size
                                    )}
                                </small>
                            </span>

                        </div>


                        {media.file_type ===
                            'IMAGE' && (
                            <>
                                <div className="info-row">

                                    <Icon name="sliders"/>

                                    <span>
                                        {formatImageSettings(
                                            media
                                        )}

                                        <small>
                                            {media.iso !==
                                            null
                                                ? `ISO ${media.iso}`
                                                : 'ISO unknown'}
                                        </small>
                                    </span>

                                </div>
                            </>
                        )}


                        {media.file_type ===
                            'VIDEO' && (
                            <div className="info-row">

                                <Icon name="sliders"/>

                                <span>
                                    {formatDuration(
                                        media.duration_seconds
                                    )}

                                    <small>
                                        {[
                                            media.frame_rate !==
                                            null
                                                ? `${media.frame_rate} fps`
                                                : null,

                                            media.video_codec,
                                        ]
                                            .filter(
                                                Boolean
                                            )
                                            .join(
                                                ' · '
                                            ) ||
                                            'Video details unavailable'}
                                    </small>
                                </span>

                            </div>
                        )}



                    </div>

                </aside>
            )}

        </div>
    );
}


function formatFileSize(
    bytes: number
): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const kilobytes =
        bytes / 1024;

    if (kilobytes < 1024) {
        return `${kilobytes.toFixed(1)} KB`;
    }

    const megabytes =
        kilobytes / 1024;

    if (megabytes < 1024) {
        return `${megabytes.toFixed(1)} MB`;
    }

    const gigabytes =
        megabytes / 1024;

    return `${gigabytes.toFixed(1)} GB`;
}


function formatImageSettings(
    media: MediaDetails
): string {
    const values: string[] = [];

    if (
        media.focal_length_mm !== null
    ) {
        values.push(
            `${media.focal_length_mm} mm`
        );
    }

    if (media.aperture !== null) {
        values.push(
            `f/${media.aperture}`
        );
    }

    if (
        media.exposure_time !== null
    ) {
        values.push(
            `${media.exposure_time}s`
        );
    }

    return (
        values.join(' · ') ||
        'Camera settings unavailable'
    );
}


function formatDuration(
    seconds: number | null
): string {
    if (seconds === null) {
        return 'Duration unknown';
    }

    const totalSeconds =
        Math.round(seconds);

    const minutes =
        Math.floor(
            totalSeconds / 60
        );

    const remainingSeconds =
        totalSeconds % 60;

    return `${minutes}:${remainingSeconds
        .toString()
        .padStart(2, '0')}`;
}


export function LibraryMediaGrid({
    items,
    density = 'comfortable',
    revision = 0,
    onToggleFavorite,
}: {
    items: LibraryMedia[];
    density?: string;
    revision?: number;
    onToggleFavorite: (
        mediaId: number,
        favoriteState: boolean
    ) => void;
}) {
    return (
        <div
            className={`photo-grid ${
                density === 'compact'
                    ? 'compact'
                    : ''
            }`}
        >
            {items.map((item, index) => (
                <div
                    key={item.media_id}
                    className="photo-library-tile"
                >
                    <Link
                        href={`/photo/${item.media_id}`}
                        scroll={false}
                        className="photo-tile"
                        aria-label={`View ${item.file_name}`}
                    >
                        <Image
                            src={`/api/media/${item.media_id}/thumbnail?v=${revision}`}
                            alt={item.file_name}
                            fill
                            sizes="(max-width: 700px) 50vw, (max-width: 1100px) 33vw, 25vw"
                            unoptimized
                            className="photo-img"
                            priority={index < 3}
                        />

                        <span className="photo-overlay">
                            <span>
                                {item.file_name}

                                <small>
                                    {item.city_name ??
                                        item.country_name ??
                                        ''}
                                </small>
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

                            onToggleFavorite(
                                item.media_id,
                                !item.favorite
                            );
                        }}
                    >
                        <Icon
                            name="heart"
                            size={18}
                        />
                    </button>
                </div>
            ))}
        </div>
    );
}

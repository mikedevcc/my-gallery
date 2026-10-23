'use client';

import { formatMediaDisplayDate } from "../lib/media-display-date";
import Image from 'next/image';
import Link from 'next/link';
import {
    useRouter,
    useSearchParams,
} from 'next/navigation';
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';


import { Icon } from './icons';
import { MediaSelectionControl } from './media-selection-control';
import { DeleteMediaModal } from './delete-media-modal';


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
    file_modified_at?: string | null;
    file_modified_timezone?: string | null;
    date_imported?: string | null;

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

type ViewerMediaItem = {
    media_id: number;
    file_name: string;
    file_type: 'IMAGE' | 'VIDEO';
    favorite?: boolean;
};

type CollectionResponse = {
    media: ViewerMediaItem[];
};

export type LibraryMedia = {
    media_id: number;
    file_name: string;
    file_type: 'IMAGE' | 'VIDEO';
    date_taken: string | null;
    capture_local?: string | null;
    capture_offset_minutes?: number | null;
    file_modified_at?: string | null;
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

    const [selectedId, setSelectedId] = useState(() => Number(id));

    const tripId = searchParams.get('tripId');
    const albumId = searchParams.get('albumId');
    const scope = searchParams.get('scope');

    const [media, setMedia] = useState<MediaDetails | null>(null);

    const [collectionMedia, setCollectionMedia] = useState<ViewerMediaItem[]>([]);

    const [loading, setLoading] = useState(true);

    const [error, setError] = useState<string | null>(null);

    const [info, setInfo] = useState(false);

    const [favorite, setFavorite] = useState(false);

    const canShare = useSyncExternalStore(
        () => () => {},
        () => typeof navigator.share === 'function',
        () => false,
    );

    const [shareError, setShareError] = useState('');

    const [deleteModalOpen, setDeleteModalOpen] = useState(false);


    const filmstripRef = useRef<HTMLDivElement>(null);
    const viewerRef = useRef<HTMLDivElement>(null);

    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showTopControls, setShowTopControls] = useState(false);
    const [showBottomControls, setShowBottomControls] = useState(false);
    const [showSideControls, setShowSideControls] = useState(false);
    const [isImmersive, setIsImmersive] = useState(false);

    const lastWheelNavigationRef = useRef(0);


    useEffect(() => {
        function handleFullscreenChange() {
            const active =
                document.fullscreenElement === viewerRef.current;

            setIsFullscreen(active);

            // Reset controls when the fullscreen state changes.
            setShowTopControls(false);
            setShowBottomControls(false);
            setShowSideControls(false);
        }

        document.addEventListener(
            'fullscreenchange',
            handleFullscreenChange
        );

        return () => {
            document.removeEventListener(
                'fullscreenchange',
                handleFullscreenChange
            );
        };
    }, []);


    useEffect(() => {
        const strip = filmstripRef.current;
        if (!strip) return;

        const selected = strip.querySelector<HTMLElement>(
            '.film-thumb.selected'
        );

        if (!selected) return;

        const stripRect = strip.getBoundingClientRect();
        const thumbRect = selected.getBoundingClientRect();

        const selectedCenter =
            thumbRect.left + thumbRect.width / 2;

        const visibleCenter =
            stripRect.left + stripRect.width / 2;

        // Calculate the absolute target based on the current
        // layout and scroll position.
        const target =
            strip.scrollLeft +
            selectedCenter -
            visibleCenter;

        const maxScroll = Math.max(
            0,
            strip.scrollWidth - strip.clientWidth
        );

        const clampedTarget = Math.max(
            0,
            Math.min(target, maxScroll)
        );

        strip.scrollTo({
            left: clampedTarget,
            behavior: 'smooth',
        });
    }, [selectedId, collectionMedia]);


    useEffect(() => {
        function handleInfoShortcut(event: KeyboardEvent) {
            if (
                event.key.toLowerCase() !== 'i' ||
                !event.ctrlKey ||
                event.altKey ||
                event.metaKey ||
                event.shiftKey
            ) {
                return;
            }

            const target = event.target;

            if (
                target instanceof HTMLElement &&
                (
                    target.isContentEditable ||
                    ['INPUT', 'TEXTAREA', 'SELECT'].includes(
                        target.tagName
                    )
                )
            ) {
                return;
            }

            // Don't toggle the information panel while
            // the delete confirmation is open.
            if (deleteModalOpen) {
                return;
            }

            event.preventDefault();
            setInfo(current => !current);
        }

        window.addEventListener('keydown', handleInfoShortcut);

        return () => {
            window.removeEventListener(
                'keydown',
                handleInfoShortcut
            );
        };
    }, [deleteModalOpen]);

    
    useEffect(() => {
        const controller = new AbortController();

        async function loadMedia() {
            setLoading(true);
            setError(null);

            try {
                const response = await fetch(
                    `/api/media/${selectedId}`,
                    { signal: controller.signal }
                );

                if (!response.ok) {
                    throw new Error(
                        `Failed to load media (${response.status})`
                    );
                }

                const result =
                    await response.json() as MediaDetails;

                if (controller.signal.aborted) return;

                setMedia(result);
                setFavorite(result.favorite);
            } catch (error) {
                if (controller.signal.aborted) return;

                setError(
                    error instanceof Error
                        ? error.message
                        : 'Failed to load media'
                );
            } finally {
                if (!controller.signal.aborted) {
                    setLoading(false);
                }
            }
        }

        void loadMedia();

        return () => controller.abort();
    }, [selectedId]);


    useEffect(() => {
        const controller = new AbortController();

        async function loadCollection() {
            try {
                let url = '/api/media?scope=all';

                if (tripId !== null) {
                    url = `/api/trips/${encodeURIComponent(tripId)}`;
                } else if (albumId !== null) {
                    url = `/api/albums/${encodeURIComponent(albumId)}`;
                }

                const response = await fetch(url, {
                    signal: controller.signal,
                });

                if (!response.ok) {
                    throw new Error(
                        `Failed to load collection (${response.status})`
                    );
                }

                const result: ViewerMediaItem[] | CollectionResponse =
                    await response.json();

                const items = Array.isArray(result)
                    ? result
                    : result.media;

                const visibleItems =
                    tripId === null &&
                    albumId === null &&
                    scope === 'favorites'
                        ? items.filter(item => item.favorite === true)
                        : items;

                if (!controller.signal.aborted) {
                    setCollectionMedia(visibleItems);
                }
            } catch (error) {
                if (!controller.signal.aborted) {
                    console.error(
                        'Failed to load viewer collection:',
                        error
                    );
                }
            }
        }

        void loadCollection();

        return () => controller.abort();
    }, [tripId, albumId, scope]);

    
    const activeMedia = collectionMedia;


    useEffect(() => {
        document.body.style.overflow = 'hidden';

        return () => {
            document.body.style.overflow = '';
        };
    }, []);


    const currentIndex = activeMedia.findIndex(
        item => item.media_id === selectedId
    );


    const openMedia = useCallback((mediaId: number) => {
        if (mediaId === selectedId) return;

        // Update the selected image without unmounting Viewer.
        setSelectedId(mediaId);

        // Preserve the originating collection in the URL.
        const query = new URLSearchParams();

        if (tripId !== null) {
            query.set('tripId', tripId);
        } else if (albumId !== null) {
            query.set('albumId', albumId);
        } else {
            query.set(
                'scope',
                scope === 'favorites' ? 'favorites' : 'all'
            );
        }

        const url = `/photo/${mediaId}?${query.toString()}`;

        // Update the address bar without starting a new route navigation.
        window.history.replaceState(
            window.history.state,
            '',
            url
        );
    }, [selectedId, tripId, albumId, scope]);


    const move = useCallback((direction: number) => {
        if (
            activeMedia.length <= 1 ||
            currentIndex === -1
        ) {
            return;
        }

        const nextIndex =
            (
                currentIndex +
                direction +
                activeMedia.length
            ) % activeMedia.length;

        openMedia(activeMedia[nextIndex].media_id);
    }, [activeMedia, currentIndex, openMedia]);


    const handleViewerWheel = useCallback(
        (event: React.WheelEvent<HTMLDivElement>) => {
            // Preserve modified scrolling.
            if (
                event.shiftKey ||
                event.ctrlKey ||
                event.altKey ||
                event.metaKey
            ) {
                return;
            }

            if (deleteModalOpen || activeMedia.length <= 1) {
                return;
            }

            // Ignore horizontal gestures.
            if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
                return;
            }

            if (event.deltaY === 0) {
                return;
            }

            // Prevent the page from scrolling.
            event.preventDefault();

            const now = performance.now();
            const cooldownMs = 200;

            if (
                now - lastWheelNavigationRef.current <
                cooldownMs
            ) {
                return;
            }

            lastWheelNavigationRef.current = now;

            // Positive deltaY = scroll down = next image.
            move(event.deltaY > 0 ? 1 : -1);
        },
        [activeMedia.length, deleteModalOpen, move]
    );


    useEffect(() => {
        function handleKeyDown(event: KeyboardEvent) {
            // Do not navigate while the delete modal is open.
            if (deleteModalOpen) {
                return;
            }

            const target = event.target;

            if (
                target instanceof HTMLElement &&
                (
                    target.isContentEditable ||
                    ['INPUT', 'TEXTAREA', 'SELECT'].includes(
                        target.tagName
                    )
                )
            ) {
                return;
            }

            // Avoid triggering shortcuts involving Ctrl, Alt or Meta.
            if (event.ctrlKey || event.altKey || event.metaKey) {
                return;
            }

            switch (event.key) {
                case 'Escape':
                    event.preventDefault();

                    if (isImmersive) {
                        setIsImmersive(false);
                    } else if (window.history.length > 1) {
                        router.back();
                    } else {
                        router.push('/');
                    }
                    break;

                case 'ArrowRight':
                    if (activeMedia.length > 1) {
                        event.preventDefault();
                        move(1);
                    }
                    break;

                case 'ArrowLeft':
                    if (activeMedia.length > 1) {
                        event.preventDefault();
                        move(-1);
                    }
                    break;

                case 'i':
                case 'I':
                    event.preventDefault();
                    setInfo(current => !current);
                    break;

                case 'f':
                case 'F':
                    event.preventDefault();
                    setIsImmersive(current => !current);
                    break;
            }
        }

        window.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [
        activeMedia,
        isImmersive,
        deleteModalOpen,
        move,
        router
    ]);


    function handleViewerPointerMove(
        event: React.PointerEvent<HTMLDivElement>
    ) {
        if (!isFullscreen) return;

        const rect = event.currentTarget.getBoundingClientRect();

        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        const edgeThreshold = 110;

        setShowTopControls(y <= edgeThreshold);
        setShowBottomControls(
            y >= rect.height - edgeThreshold
        );
        setShowSideControls(
            x <= edgeThreshold ||
            x >= rect.width - edgeThreshold
        );
    }

    function handleViewerPointerLeave() {
        if (!isFullscreen) return;

        setShowTopControls(false);
        setShowBottomControls(false);
        setShowSideControls(false);
    }


    function back() {
        if (window.history.length > 1) {
            router.back();
        } else {
            router.push('/');
        }
    }


    if (loading && media === null) {
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


    if (!media) {
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


    const isCurrentMedia = media.media_id === selectedId;


    const position =
        currentIndex >= 0
            ? currentIndex + 1
            : 1;

    const total = activeMedia.length > 0
    ? activeMedia.length
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
        <>
            <div
                ref={viewerRef}
                className={[
                    'viewer',
                    isImmersive ? 'viewer-immersive' : '',
                    isImmersive && showTopControls ? 'show-top-controls' : '',
                    isImmersive && showBottomControls ? 'show-bottom-controls' : '',
                    isImmersive && showSideControls ? 'show-side-controls' : '',
                ].filter(Boolean).join(' ')}
                role="dialog"
                aria-modal="true"
                aria-label={`Media viewer: ${media.file_name}`}
                onPointerMove={handleViewerPointerMove}
                onPointerLeave={handleViewerPointerLeave}
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
                                type="button"
                                className="viewer-icon viewer-delete"
                                aria-label="Delete media"
                                title="Delete media"
                                onClick={() => setDeleteModalOpen(true)}
                            >
                                <Icon name="trash" />
                            </button>


                            <button
                                type="button"
                                className={`viewer-icon ${info ? 'active' : ''}`}
                                aria-label={info ? 'Hide information' : 'Show information'}
                                aria-pressed={info}
                                aria-keyshortcuts="I"
                                title="Information (I)"
                                onClick={() => setInfo(current => !current)}
                            >
                                <Icon name="info" />
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


                    {isFullscreen && (
                        <button
                            type="button"
                            className="viewer-fullscreen-exit"
                            aria-label="Exit fullscreen"
                            title="Exit fullscreen (F)"
                            onClick={() => {
                                setIsImmersive(false);
                            }}
                        >
                            <Icon name="close" size={24} />
                        </button>
                    )}


                    {shareError && <p role="alert">{shareError}</p>}

                    <div
                        className="viewer-stage"
                        onWheel={handleViewerWheel}
                    >

                        {activeMedia.length > 1 && (
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


                        {error ? (
                            <div className="viewer-media-status" role="alert">
                                <p>{error}</p>
                            </div>
                        ) : !isCurrentMedia ? (
                            <div className="viewer-media-status" role="status">
                                <p>Loading media...</p>
                            </div>
                        ) : media.file_type === 'IMAGE' ? (
                            <Image
                                src={fileUrl}
                                alt={media.file_name}
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
                                poster={thumbnailUrl}
                                style={{
                                    width: '100%',
                                    height: '100%',
                                    objectFit: 'contain',
                                }}
                            />
                        )}


                        {activeMedia.length > 1 && (
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


                    {activeMedia.length > 0 && (
                        <div
                            ref={filmstripRef}
                            className="filmstrip"
                            aria-label="Media thumbnails"
                        >
                            {activeMedia.map(item => {
                                const selected =
                                    item.media_id === selectedId;

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
                            })}
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
                                    {formatMediaDisplayDate(media)}
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

            
            <DeleteMediaModal
                open={deleteModalOpen}
                mediaIds={[media.media_id]}
                onClose={() => setDeleteModalOpen(false)}
                onDeleted={(confirmedIds) => {
                    if (confirmedIds.includes(media.media_id)) {
                        setDeleteModalOpen(false);
                        back();
                    }
                }}
            />
        </>
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
    selectedMediaIds = [],
    onToggleSelection,
    scope = 'all',
}: {
    items: LibraryMedia[];
    density?: string;
    revision?: number;
    onToggleFavorite: (
        mediaId: number,
        favoriteState: boolean
    ) => void;
    selectedMediaIds?: number[];
    onToggleSelection?: (mediaId: number) => void;
    scope?: 'all' | 'favorites';
}) {
    const selectedIds = new Set(selectedMediaIds);

    return (
        <div
            className={`photo-grid ${
                density === 'compact' ? 'compact' : ''
            }`}
        >
            {items.map((item, index) => {
                const selected = selectedIds.has(item.media_id);

                return (
                    <div
                        key={item.media_id}
                        className={`photo-library-tile ${
                            selected ? 'selected' : ''
                        }`}
                    >
                        <Link
                            href={`/photo/${item.media_id}?scope=${scope}`}
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

                        {onToggleSelection && (
                            <MediaSelectionControl
                                selected={selected}
                                mediaName={item.file_name}
                                onToggle={() =>
                                    onToggleSelection(item.media_id)
                                }
                            />
                        )}

                        <button
                            type="button"
                            className={
                                item.favorite
                                    ? 'photo-favorite is-favorite'
                                    : 'photo-favorite'
                            }
                            aria-label={`${
                                item.favorite
                                    ? 'Remove from'
                                    : 'Add to'
                            } favorites: ${item.file_name}`}
                            aria-pressed={item.favorite}
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();

                                onToggleFavorite(
                                    item.media_id,
                                    !item.favorite
                                );
                            }}
                        >
                            <Icon name="heart" size={18} />
                        </button>
                    </div>
                );
            })}
        </div>
    );
}

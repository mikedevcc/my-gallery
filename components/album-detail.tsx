'use client';

import {
    useState,
    useRef,
    useCallback,
    useEffect,
} from "react";

import Image from 'next/image';
import Link from "next/link";
import { useRouter } from 'next/navigation';

import { useBulkMedia } from "../lib/use-bulk-media";
import { BulkMediaFeedback } from "./bulk-media-feedback";
import { groupMediaByDate } from '@/lib/media-grouping';

import { Icon } from './icons';
import { AlbumMediaPicker } from "./album-media-picker";
import { AlbumMediaTransferModal } from './move-media-modal';
import { DeleteMediaModal } from './delete-media-modal';
import { CollectionMenu } from "./collection-menu";


type AlbumRow = {
    album_id: number;
    album_name: string;
    cover_media_id: number | null;
};

type AlbumMediaRow = {
    media_id: number;
    file_name: string;
    file_type: 'IMAGE' | 'VIDEO';
    path: string;
    date_taken: string | null;
    capture_local?: string | null;
    capture_offset_minutes?: number | null;
    date_imported: string;
    width: number | null;
    height: number | null;
    favorite: boolean;
};

type AlbumResponse = {
    album: AlbumRow;
    media: AlbumMediaRow[];
};


export function AlbumDetail({
    albumId
}: {
    albumId: string;
}) {
    const bulkRemoval = useBulkMedia("album-remove", Number(albumId));
    const live = useRef(false);
    const loadVersion = useRef(0);
    const loadingRequest = useRef<AbortController | null>(null);
    const [data, setData] = useState<AlbumResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [thumbnailRevision, setThumbnailRevision] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const [mediaPickerOpen, setMediaPickerOpen] = useState(false);

    const [selectedMediaIds, setSelectedMediaIds] =
        useState<number[]>(() => {
            if (typeof window === 'undefined') {
                return [];
            }

            const key = `album-selection:${albumId}`;
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

    const [
        transferOperation,
        setTransferOperation
    ] = useState<'move' | 'copy' | null>(null);
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);

    const [group, setGroup] = useState<'All' | 'Years' | 'Months' | 'Days'>('All');


    const router = useRouter();

    const selectionStorageKey = `album-selection:${albumId}`;


    function toggleMediaSelection(mediaId: number) {
        if (bulkRemoval.busy) return;
        if (!selectedMediaIds.includes(mediaId)) bulkRemoval.available(mediaId);
        setSelectedMediaIds(current =>
            current.includes(mediaId)
                ? current.filter(id => id !== mediaId)
                : [...current, mediaId]
        );
    }



    const refreshAlbum = useCallback(async () => {
        const version = ++loadVersion.current;
        loadingRequest.current?.abort();
        const controller = new AbortController();
        loadingRequest.current = controller;
        try {
            const response = await fetch(`/api/albums/${albumId}`, { signal: controller.signal, cache: 'no-store' });
            if (!response.ok) throw new Error();
            const result = await response.json() as AlbumResponse;
            if (live.current && version === loadVersion.current) { setData(result); setError(null); }
        } catch {
            if (live.current && version === loadVersion.current) setError("Could not refresh this album. Reload the page to verify its current contents.");
        } finally {
            if (live.current && version === loadVersion.current) setLoading(false);
        }
    }, [albumId]);

    async function removeSelectedFromAlbum() {
        if (data?.album.album_id !== Number(albumId)) return;
        if (!bulkRemoval.canRun(validSelectedMediaIds)) return;
        if (!window.confirm(`Remove ${validSelectedMediaIds.length} selected items from this album?`)) return;
        await bulkRemoval.run(validSelectedMediaIds, ids => {
            setSelectedMediaIds(current => current.filter(id => !ids.includes(id)));
        });
    }

    const cancelRefresh = useCallback(() => {
        ++loadVersion.current;
        loadingRequest.current?.abort();
    }, []);

    useEffect(() => {
        live.current = true;
        let cancelled = false;
        void Promise.resolve().then(() => { if (!cancelled) void refreshAlbum(); });
        const updated = () => { setThumbnailRevision(current => current + 1); void refreshAlbum(); };
        window.addEventListener('media-library-updated', updated);
        return () => {
            cancelled = true;
            live.current = false;
            cancelRefresh();
            window.removeEventListener('media-library-updated', updated);
        };
    }, [refreshAlbum, cancelRefresh]);


    if (loading) {
        return <p>Loading album...</p>;
    }

    if (!data) {
        return (
            <div className="empty-state">
                <h2>Unable to load album</h2>
                <p>{error ?? 'Album not found'}</p>
            </div>
        );
    }


    const {
        album,
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
        if (bulkRemoval.busy) return;
        if (allMediaSelected) {
            setSelectedMediaIds([]);
            return;
        }

        media.forEach(item => bulkRemoval.available(item.media_id));
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

        await refreshAlbum();
    }


    async function renameCurrentAlbum(
        albumName: string
    ) {
        const response = await fetch(
            `/api/albums/${album.album_id}`,
            {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    albumName,
                }),
            }
        );

        if (!response.ok) {
            throw new Error(
                'Failed to rename album'
            );
        }

        await refreshAlbum();
    }

    
    async function deleteCurrentAlbum() {
        const confirmed = window.confirm(
            `Delete "${album.album_name}"?\n\nThe photos will not be deleted.`
        );

        if (!confirmed) {
            return;
        }
    
        const response = await fetch(
            `/api/albums/${album.album_id}`,
            {
                method: 'DELETE',
            }
        );

        if (!response.ok) {
            throw new Error(
                'Failed to delete album'
            );
        }

        router.push('/albums');
    }

    
    return (
        <>
            {error && <p role="alert">{error}</p>}
            <div className="album-hero">
                {album.cover_media_id !== null && (
                    <Image
                        src={`/api/media/${album.cover_media_id}/thumbnail?v=${thumbnailRevision}`}
                        alt={album.album_name}
                        fill
                        unoptimized
                    />
                )}
                <div className="album-hero-shade"/>


                <button
                    type="button"
                    className="album-back-button"
                    onClick={() => router.back()}
                >
                    <Icon
                        name="back"
                        size={18}
                    />
                    Back
                </button>

                <CollectionMenu
                    type="trip"
                    name={album.album_name}
                    onRename={renameCurrentAlbum}
                    onDelete={deleteCurrentAlbum}
                />

                <div className="album-hero-content">
                    <div className="hero-eyebrow">
                        <Icon
                            name="albums"
                            size={15}
                        />

                        ALBUM
                    </div>

                    <h1>
                        {album.album_name}
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

            <div className="album-controls-wrapper">
                <div className="timeline-controls">
                    <div className="segmented">
                        {['All', 'Years', 'Months','Days'].map(value => (
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
                                            'All' | 
                                            'Years' |
                                            'Months' |
                                            'Days'
                                    )
                                }
                            >
                                {value}
                            </button>
                        ))}
                    </div>

                    <button
                        type="button"
                        className="album-add-media"
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
                    <div className="album-selection-bar">

                        <div className="album-selection-summary">
                            <span>
                                {validSelectedMediaIds.length} selected
                            </span>

                            <button
                                type="button"
                                className="album-select-all"
                                onClick={toggleSelectAll}
                            >
                                {allMediaSelected
                                    ? 'Unselect all'
                                    : 'Select all'}
                            </button>
                        </div>

                        <div className="album-selection-actions">

                            <button
                                type="button"
                                disabled={bulkRemoval.busy || album.album_id !== Number(albumId) || !bulkRemoval.canRun(validSelectedMediaIds)}
                                onClick={() => {
                                    void removeSelectedFromAlbum();
                                }}
                            >
                                Remove from album
                            </button>

                            <button
                                type="button"
                                onClick={() => {
                                    setTransferOperation('copy');
                                }}
                            >
                                Copy to album
                            </button>

                            <button
                                type="button"
                                onClick={() => {
                                    setTransferOperation('move');
                                }}
                            >
                                Move to album
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

            {media.length === 0 ? (
                <div className="empty-state">
                    <Icon
                        name="photos"
                        size={36}
                    />

                    <h2>No media yet</h2>

                    <p>
                        Add photos or videos to this album.
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
                                    className={`album-media-tile ${
                                        validSelectedMediaIds.includes(item.media_id)
                                            ? 'selected'
                                            : ''
                                    }`}
                                >
                                    <Link
                                        href={`/photo/${item.media_id}?albumId=${album.album_id}`}
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
                                        className="album-media-select"
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

            <AlbumMediaPicker
                key={`album-picker-${album.album_id}`}
                albumId={album.album_id}
                open={mediaPickerOpen}
                onClose={() =>
                    setMediaPickerOpen(false)
                }
            />

            <AlbumMediaTransferModal
                open={transferOperation !== null}
                sourceAlbumId={album.album_id}
                mediaIds={validSelectedMediaIds}
                operation={transferOperation ?? 'move'}
                onClose={() => {
                    setTransferOperation(null);
                }}
                onCompleted={() => {
                    setSelectedMediaIds([]);

                    if (transferOperation === 'move') {
                        void refreshAlbum();
                    }

                    setTransferOperation(null);
                }}
            />

            <DeleteMediaModal
                key={`delete-media-${album.album_id}`}
                open={deleteModalOpen}
                mediaIds={validSelectedMediaIds}
                onClose={() => {
                    setDeleteModalOpen(false);
                }}
                onDeleted={ids => {
                    setSelectedMediaIds(current => current.filter(id => !ids.includes(id)));
                }}
            />
        </>
    );
}
'use client';

import {
    useState,
    useEffect,
} from "react";

import Image from 'next/image';
import Link from "next/link";
import { useRouter } from 'next/navigation';

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
    const [data, setData] = useState<AlbumResponse | null>(null);
    const [loading, setLoading] = useState(true);
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

    const [group, setGroup] = useState<'All' | 'Days'>('All');


    const router = useRouter();

    const selectionStorageKey = `album-selection:${albumId}`;


    function toggleMediaSelection(mediaId: number) {
        setSelectedMediaIds(current =>
            current.includes(mediaId)
                ? current.filter(id => id !== mediaId)
                : [...current, mediaId]
        );
    }



    async function refreshAlbum() {
        setError(null);

        try {
            const response =
                await fetch(`/api/albums/${albumId}`);

            if (!response.ok) {
                throw new Error(
                    `Failed to load album (${response.status})`
                );
            }

            const result = await response.json() as AlbumResponse;

            setData(result);
        }
        catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Failed to load album'
            );
        }
    }

    
    async function removeSelectedFromAlbum() {
        if (validSelectedMediaIds.length === 0) {
            return;
        }

        const confirmed = window.confirm(
            `Remove ${validSelectedMediaIds.length} selected item${
                validSelectedMediaIds.length === 1 ? '' : 's'
            } from this album?`
        );

        if (!confirmed) {
            return;
        }

        try {
            for (const mediaId of validSelectedMediaIds) {
                const response = await fetch(
                    `/api/albums/${album.album_id}/media`,
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
            await refreshAlbum();
        }
        catch (error) {
            console.error(
                'Failed to remove media from album:',
                error
            );
        }
    }
    
    
    useEffect(() => {
        async function loadAlbum() {
            try {
                const response =
                    await fetch(`/api/albums/${albumId}`);

                if (!response.ok) {
                    throw new Error(
                        `Failed to load album (${response.status})`
                    );
                }

                const result =
                    await response.json() as AlbumResponse;

                setData(result);
            }
            catch (error) {
                setError(
                    error instanceof Error
                        ? error.message
                        : 'Failed to load album'
                );
            }
            finally {
                setLoading(false);
            }
        }

        void loadAlbum();
    }, [albumId]);


    if (loading) {
        return <p>Loading album...</p>;
    }

    if (error || !data) {
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
            <div className="album-hero">
                {album.cover_media_id !== null && (
                    <Image
                        src={`/api/media/${album.cover_media_id}/thumbnail`}
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
                        {['All', 'Days'].map(value => (
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
                                            'All' | 'Days'
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
                                            src={`/api/media/${item.media_id}/thumbnail`}
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
                albumId={album.album_id}
                open={mediaPickerOpen}
                onClose={() =>
                    setMediaPickerOpen(false)
                }
                onAdded={() => {
                    void refreshAlbum();
                }}
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
                open={deleteModalOpen}
                mediaIds={validSelectedMediaIds}
                onClose={() => {
                    setDeleteModalOpen(false);
                }}
                onDeleted={() => {
                    setSelectedMediaIds([]);
                    void refreshAlbum();
                }}
            />
        </>
    );
}
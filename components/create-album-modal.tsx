'use client';

import { useState } from 'react';

type CreateAlbumModalProps = {
    open: boolean;
    onClose: () => void;
    onCreated: () => void;
};

export function CreateAlbumModal({
    open,
    onClose,
    onCreated,
}: CreateAlbumModalProps) {
    const [albumName, setAlbumName] = useState('');

    const [creating, setCreating] = useState(false);

    const [error, setError] = useState<string | null>(null);

    if (!open) {
        return null;
    }

    async function createAlbum() {
        const trimmedName = albumName.trim();

        if (trimmedName.length === 0) {
            setError('Album name cannot be empty.');
            return;
        }

        setCreating(true);
        setError(null);

        try {
            const response =
                await fetch('/api/albums', {
                    method: 'POST',
                    headers: {
                        'Content-Type':
                            'application/json',
                    },
                    body: JSON.stringify({
                        albumName:
                            trimmedName,
                    }),
                });

            if (!response.ok) {
                const result =
                    await response.json() as {
                        error?: string;
                    };

                throw new Error(
                    result.error ??
                    `Failed to create album (${response.status})`
                );
            }

            setAlbumName('');

            onCreated();
            onClose();
        }
        catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Failed to create album'
            );
        }
        finally {
            setCreating(false);
        }
    }

    function handleClose() {
        setAlbumName('');
        setError(null);
        onClose();
    }

    return (
        <div className="create-album-backdrop">
            <div className="create-album-modal">

                <div className="create-album-header">
                    <div>
                        <h2>Create album</h2>

                        <p>
                            Create a new collection
                            for your media.
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={handleClose}
                        aria-label="Close"
                        disabled={creating}
                    >
                        ×
                    </button>
                </div>

                <div className="create-album-content">

                    <label htmlFor="album-name">
                        Album name
                    </label>

                    <input
                        id="album-name"
                        type="text"
                        value={albumName}
                        onChange={event =>
                            setAlbumName(
                                event.target.value
                            )
                        }
                        placeholder="e.g. Foodie"
                        maxLength={100}
                        autoFocus
                    />

                    {error && (
                        <p className="error">
                            {error}
                        </p>
                    )}

                </div>

                <div className="create-album-footer">

                    <button
                        type="button"
                        onClick={onClose}
                        disabled={creating}
                    >
                        Cancel
                    </button>

                    <button
                        type="button"
                        onClick={() => {
                            void createAlbum();
                        }}
                        disabled={
                            creating ||
                            albumName.trim().length === 0
                        }
                    >
                        {creating
                            ? 'Creating...'
                            : 'Create album'}
                    </button>

                </div>

            </div>
        </div>
    );
}

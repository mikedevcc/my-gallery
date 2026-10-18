'use client';

import { useState } from 'react';

type DeleteMediaModalProps = {
    open: boolean;
    mediaIds: number[];
    onClose: () => void;
    onDeleted: () => void;
};

export function DeleteMediaModal({
    open,
    mediaIds,
    onClose,
    onDeleted,
}: DeleteMediaModalProps) {
    const [deleting, setDeleting] =
        useState(false);

    const [error, setError] =
        useState<string | null>(null);

    if (!open) {
        return null;
    }

    async function deleteMedia() {
        if (mediaIds.length === 0) {
            return;
        }

        setDeleting(true);
        setError(null);

        try {
            for (const mediaId of mediaIds) {
                const response = await fetch(
                    `/api/media/${mediaId}`,
                    {
                        method: 'DELETE',
                    }
                );

                if (!response.ok) {
                    const result =
                        await response.json() as {
                            error?: string;
                        };

                    throw new Error(
                        result.error ??
                        `Failed to delete media ${mediaId}`
                    );
                }
            }

            onDeleted();
            onClose();
        }
        catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Failed to delete media'
            );
        }
        finally {
            setDeleting(false);
        }
    }

    return (
        <div className="delete-media-backdrop">
            <div className="delete-media-modal">

                <div className="delete-media-header">
                    <div>
                        <h2>Delete media?</h2>

                        <p>
                            {mediaIds.length}{' '}
                            {mediaIds.length === 1
                                ? 'item'
                                : 'items'}{' '}
                            selected
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        disabled={deleting}
                    >
                        ×
                    </button>
                </div>

                <div className="delete-media-content">

                    <div className="destructiveWarning">
                        <h3>
                            This cannot be undone
                        </h3>

                        <p>
                            The selected media will be permanently
                            removed from the library and the original
                            files will be deleted from server storage.
                        </p>
                    </div>

                    {error && (
                        <p className="error">
                            {error}
                        </p>
                    )}

                </div>

                <div className="delete-media-footer">

                    <button
                        type="button"
                        onClick={onClose}
                        disabled={deleting}
                    >
                        Cancel
                    </button>

                    <button
                        type="button"
                        className="danger"
                        onClick={() => {
                            void deleteMedia();
                        }}
                        disabled={
                            deleting ||
                            mediaIds.length === 0
                        }
                    >
                        {deleting
                            ? 'Deleting...'
                            : 'Delete permanently'}
                    </button>

                </div>

            </div>
        </div>
    );
}
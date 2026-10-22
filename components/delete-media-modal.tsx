'use client';

import { useBulkMedia } from "../lib/use-bulk-media";
import { BulkMediaFeedback } from "./bulk-media-feedback";

type DeleteMediaModalProps = {
    open: boolean;
    mediaIds: number[];
    onClose: () => void;
    onDeleted: (confirmedIds: number[]) => void;
};

export function DeleteMediaModal({
    open,
    mediaIds,
    onClose,
    onDeleted,
}: DeleteMediaModalProps) {
    const bulk = useBulkMedia("delete");
    const deleting = bulk.busy;
    if (!open) return null;
    async function deleteMedia() { await bulk.run(mediaIds, onDeleted); }

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

                    <BulkMediaFeedback items={bulk.items} />

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
                            !bulk.canRun(mediaIds)
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
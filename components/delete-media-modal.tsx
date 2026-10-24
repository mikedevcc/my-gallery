'use client';

import { useId } from 'react';

import { useBulkMedia } from "../lib/use-bulk-media";
import { useModalDialog } from '../lib/use-modal-dialog';

import { BulkMediaFeedback } from "./bulk-media-feedback";

type DeleteMediaModalProps = {
    open: boolean;
    mediaIds: number[];
    fileName?: string;
    onClose: () => void;
    onDeleted: (confirmedIds: number[]) => void;
};

export function DeleteMediaModal({
    open,
    mediaIds,
    fileName,
    onClose,
    onDeleted,
}: DeleteMediaModalProps) {
    const bulk = useBulkMedia("delete");
    const deleting = bulk.busy;
    const titleId = useId();
    const descriptionId = useId();

    const { dialogRef, handleCancel } = useModalDialog(
        open,
        deleting,
        onClose
    );

    if (!open) return null;

    async function deleteMedia() {
        if (deleting) return;

        const result = await bulk.run(mediaIds, onDeleted);

        if (result?.allConfirmed) {
            onClose();
        }
    }


    return (
        <dialog
            ref={dialogRef}
            className="delete-media-backdrop"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onCancel={handleCancel}
        >
            <div className="delete-media-modal">

                <div className="delete-media-header">
                    <div>
                        <h2 id={titleId}>Delete media?</h2>

                        <p>
                            {mediaIds.length === 1 && fileName
                                ? `Permanently delete "${fileName}"?`
                                : `${mediaIds.length} ${mediaIds.length === 1 ? "item" : "items"} selected`}
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

                        <p id={descriptionId}>
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
                        autoFocus
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
        </dialog>
    );
}
"use client";

import { useRef } from "react";
import { Icon } from "./icons";
import { useImportQueue } from "@/lib/import/use-import-queue";

export function UploadControl() {
    const inputRef = useRef<HTMLInputElement>(null);

    const {
        conflicts,
        startImport,
        resolveConflict,
    } = useImportQueue();

    function openFilePicker(): void {
        inputRef.current?.click();
    }

    async function handleFileSelection(
        event: React.ChangeEvent<HTMLInputElement>
    ): Promise<void> {
        const fileList = event.target.files;

        if (!fileList) {
            return;
        }

        const files = Array.from(fileList);

        await startImport(files);
    }

    return (
        <>
            <button
                className="upload-btn"
                type="button"
                onClick={openFilePicker}
            >
                <Icon name="plus" size={17}/>
                <span>Upload</span>
            </button>

            <input
                ref={inputRef}
                type="file"
                multiple
                accept="image/*,video/*"
                onChange={handleFileSelection}
                hidden
            />

            <div>
                {conflicts.map((conflict) => (
                    <button
                        key={conflict.conflictId}
                        type="button"
                        onClick={() =>
                            resolveConflict(conflict, "SKIP")
                        }
                    >
                        Skip {conflict.type} conflict
                    </button>
                ))}
            </div>
        </>
    );
}
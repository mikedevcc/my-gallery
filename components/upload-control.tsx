"use client";

import { useRef, useState } from "react";
import { mediaUploadAccept } from "@/lib/media-formats";
import type { ConflictAction } from "@/lib/import/import-conflict";
import { ImportConflictModal } from "./import-conflict-modal";
import { ImportFeedback } from "./import-feedback";
import { Icon } from "./icons";
import { useImportQueue } from "@/lib/import/use-import-queue";

export function UploadControl() {
    const inputRef = useRef<HTMLInputElement>(null);
    const resolvingRef = useRef(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const {
        jobs,
        conflicts,
        isImporting,
        isRecovering,
        recoveryError,
        startImport,
        retryJob,
        resolutionBlocked,
        resolveConflict,
        resolveAllConflicts,
    } = useImportQueue();

    const conflict = conflicts[0];

    async function handleResolution(action: ConflictAction, all = false): Promise<void> {
        if (!conflict || resolvingRef.current) return;
        resolvingRef.current = true;
        setBusy(true);
        setError(null);
        try {
            if (all) {
                await resolveAllConflicts(action);
            } else {
                await resolveConflict(conflict, action);
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not resolve this conflict. Please try again.");
        } finally {
            resolvingRef.current = false;
            setBusy(false);
        }
    }

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

        event.target.value = "";
        setError(null);
        await startImport(files);
    }

    return (
        <>
            <button
                className="upload-btn"
                type="button"
                onClick={openFilePicker}
                disabled={isRecovering || !!recoveryError || isImporting || conflicts.length > 0 || busy}
            >
                <Icon name="plus" size={17}/>
                <span>Upload</span>
            </button>

            <input
                ref={inputRef}
                type="file"
                multiple
                accept={mediaUploadAccept}
                onChange={handleFileSelection}
                hidden
            />

            <ImportFeedback jobs={jobs} disabled={isImporting || isRecovering || !!recoveryError || conflicts.length > 0 || busy} onRetry={id => { void retryJob(id); }} />
            {resolutionBlocked && <span role="alert">Refresh the page to reload pending conflicts before another resolution attempt.</span>}
            {recoveryError && <span role="alert">{recoveryError}</span>}
            {conflict && (
                <ImportConflictModal
                    conflict={conflict}
                    incomingFilename={jobs.find(job => job.id === conflict.jobId)?.fileName ?? (conflict.type === "FILENAME" ? conflict.existingFilename : undefined) ?? "Incoming file"}
                    remaining={conflicts.length}
                    bulkRemaining={conflicts.filter(item => item.type === "FILENAME").length}
                    busy={busy || isImporting || resolutionBlocked}
                    error={error}
                    onResolve={action => { void handleResolution(action); }}
                    onResolveAll={action => { void handleResolution(action, true); }}
                />
            )}
        </>
    );
}
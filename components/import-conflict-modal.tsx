"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ConflictAction, ImportConflict } from "@/lib/import/import-conflict";
import { Icon } from "./icons";
import styles from "./import-conflict-modal.module.css";

type Props = {
    conflict: ImportConflict;
    incomingFilename: string;
    remaining: number;
    bulkRemaining: number;
    busy: boolean;
    error: string | null;
    onResolve: (action: ConflictAction) => void;
    onResolveAll: (action: ConflictAction) => void;
};

export function ImportConflictModal({ conflict, incomingFilename, remaining, bulkRemaining, busy, error, onResolve, onResolveAll }: Props) {
    const [expanded, setExpanded] = useState<"incoming" | "existing" | null>(null);
    const [pendingBulk, setPendingBulk] = useState<ConflictAction | null>(null);
    const cancelRef = useRef<HTMLButtonElement>(null);
    const bulkTriggerRef = useRef<HTMLButtonElement | null>(null);
    const dialogRef = useRef<HTMLDialogElement>(null);
    const skipRef = useRef<HTMLButtonElement>(null);
    const titleId = useId();
    const descriptionId = useId();
    const existingPath = conflict.type === "FILENAME" ? conflict.existingPath : null;
    const existingFilename = existingPath?.split(/[\\/]/).filter(Boolean).pop() ?? `Media #${conflict.existingMediaId}`;

    useEffect(() => {
        const dialog = dialogRef.current;
        const previousFocus = document.activeElement;
        const previousOverflow = document.body.style.overflow;
        dialog?.showModal();
        document.body.style.overflow = "hidden";
        return () => {
            dialog?.close();
            document.body.style.overflow = previousOverflow;
            if (previousFocus instanceof HTMLElement) previousFocus.focus();
        };
    }, []);

    useEffect(() => {
        if (!busy) skipRef.current?.focus();
    }, [conflict.conflictId, busy]);

    useEffect(() => {
        if (pendingBulk) cancelRef.current?.focus();
    }, [pendingBulk]);

    function cancelBulk() {
        setPendingBulk(null);
        bulkTriggerRef.current?.focus();
    }

    const bulkLabel = pendingBulk === "SKIP" ? "Skip all" : pendingBulk === "KEEP_BOTH" ? "Keep both (all)" : "Replace all";
    const bulkWarning = pendingBulk === "SKIP"
        ? "All affected incoming files will be skipped. The existing files will stay in your library."
        : pendingBulk === "KEEP_BOTH"
            ? "All affected incoming files will be imported alongside the existing files, using additional storage."
            : "All affected existing files will be overwritten by the incoming files. This cannot be undone.";

    return (
        <dialog onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (pendingBulk) cancelBulk(); else setExpanded(null); } }} ref={dialogRef} className={styles.dialog} aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={event => event.preventDefault()}>
            {expanded && <div className={styles.expanded}>
                <button type="button" onClick={() => setExpanded(null)}>Back to comparison</button>
                <ConflictPreview key={`${conflict.conflictId}-${expanded}`} conflictId={conflict.conflictId} side={expanded} filename={expanded === "incoming" ? incomingFilename : existingFilename} large />
            </div>}
            <div hidden={!!expanded} className={styles.content} aria-busy={busy}>
                <header className={styles.header}>
                    <span className={styles.badge}><Icon name="upload" size={16} /> Media import</span>
                    <span className={styles.count} role="status">{remaining} conflict{remaining === 1 ? "" : "s"} remaining</span>
                </header>
                <h2 id={titleId}>{conflict.type === "FILENAME" ? "This filename already exists" : "This media already exists"}</h2>
                <p id={descriptionId} className={styles.description}>Choose which file to keep in your library.</p>
                <div className={styles.comparison}>
                    <section className={styles.card} aria-label="Incoming file">
                        <h3>Incoming</h3>
                        <ConflictPreview conflictId={conflict.conflictId} side="incoming" filename={incomingFilename} onOpen={() => setExpanded("incoming")} />
                        <div className={styles.details}><strong>{incomingFilename}</strong><span>Selected for import</span></div>
                    </section>
                    <section className={styles.card} aria-label="Existing file">
                        <h3>Existing</h3>
                        <ConflictPreview conflictId={conflict.conflictId} side="existing" filename={existingFilename} onOpen={() => setExpanded("existing")} />
                        <div className={styles.details}><strong>{existingFilename}</strong><span>{existingPath?.split(/[\\/]/).filter(Boolean).slice(-3, -1).join(" / ") ?? "Already in your library"}</span></div>
                    </section>
                </div>
                {error && <p className={styles.error} role="alert">{error}</p>}
                <footer className={styles.footer}>
                    {pendingBulk ? (
                        <div className={`${styles.warning} ${pendingBulk === "REPLACE" ? styles.destructiveWarning : ""}`}>
                            <div role="alert">
                                <h3>{bulkLabel}?</h3>
                                <p>This applies to {bulkRemaining} filename conflict{bulkRemaining === 1 ? "" : "s"}. {bulkWarning}</p>
                            </div>
                            <div className={styles.confirmActions}>
                                <button ref={cancelRef} type="button" disabled={busy} onClick={cancelBulk}>Cancel</button>
                                <button className={pendingBulk === "REPLACE" ? styles.replace : styles.primary} type="button" disabled={busy || bulkRemaining === 0} onClick={() => {
                                    const action = pendingBulk;
                                    setPendingBulk(null);
                                    onResolveAll(action);
                                }}>Confirm {bulkLabel.toLowerCase()}</button>
                            </div>
                        </div>
                    ) : <>
                    <div className={styles.actionGroup} role="group" aria-label="Resolve this file">
                        <p className={styles.actionLabel}>This file</p>
                        <div className={styles.actions}>
                            <button ref={skipRef} type="button" disabled={busy} onClick={() => onResolve("SKIP")}>Skip</button>
                            <button className={styles.primary} type="button" disabled={busy} onClick={() => onResolve("KEEP_BOTH")}>Keep both</button>
                            <button className={styles.replace} type="button" disabled={busy} onClick={() => onResolve("REPLACE")}>Replace</button>
                        </div>
                    </div>
                    <div className={styles.actionGroup} role="group" aria-label="Resolve all filename conflicts">
                        <p className={styles.actionLabel}>All filename conflicts <span>({bulkRemaining})</span></p>
                        <div className={styles.actions}>
                            <button type="button" disabled={busy || bulkRemaining === 0} onClick={event => { bulkTriggerRef.current = event.currentTarget; setPendingBulk("SKIP"); }}>Skip all</button>
                            <button className={styles.bulkPrimary} type="button" disabled={busy || bulkRemaining === 0} onClick={event => { bulkTriggerRef.current = event.currentTarget; setPendingBulk("KEEP_BOTH"); }}>Keep both (all)</button>
                            <button className={styles.replace} type="button" disabled={busy || bulkRemaining === 0} onClick={event => { bulkTriggerRef.current = event.currentTarget; setPendingBulk("REPLACE"); }}>Replace all</button>
                        </div>
                    </div>
                    </>}
                </footer>
                <p className={styles.hint} role="status">{busy ? "Applying your choice…" : "Skip keeps the existing file. Keep both saves both files. Replace overwrites the existing file."}</p>
            </div>
        </dialog>
    );
}

function ConflictPreview({ conflictId, side, filename, onOpen, large = false }: {
    conflictId: string; side: "incoming" | "existing"; filename: string; onOpen?: () => void; large?: boolean;
}) {
    const [failedUrl, setFailedUrl] = useState<string | null>(null);
    const url = `/api/import/conflict/preview?id=${encodeURIComponent(conflictId)}&side=${side}`;
    const video = /\.(mp4|mov|webm)$/i.test(filename);
    const media = failedUrl === url
        ? <><Icon name="photos" size={30} /><span>Preview unavailable</span></>
        : video
            ? <video src={url} controls={large} muted={!large} preload="metadata" onError={() => setFailedUrl(url)} />
            // Local media is served by the conflict endpoint, including staged uploads.
            // eslint-disable-next-line @next/next/no-img-element
            : <img src={url} alt={filename} onError={() => setFailedUrl(url)} />;
    return large ? <div className={styles.largePreview}>{media}</div>
        : <button type="button" className={styles.preview} onClick={onOpen} disabled={failedUrl === url} aria-label={`Open larger preview of ${side} file: ${filename}`}>{media}</button>;
}

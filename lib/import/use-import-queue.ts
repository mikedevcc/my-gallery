"use client";

import { useEffect, useRef, useState } from "react";
import type { ImportJob } from "./import-job";
import type { PublicImportConflict as ImportConflict, ConflictAction } from "./import-conflict";
import { createImportJobs } from "./create-import-jobs";
import { validateImportJobs, applyValidationResults } from "./validate-import-jobs";
import { processImportQueue } from "./process-import-queue";
import { uploadImportFile } from "./upload-import-file";
import { resolveConflictBatch, type ResolveConflictResponse } from "./resolve-import-conflict";
import { createImportNotifier, readConflict } from "./import-feedback";

export function useImportQueue() {
    const [jobs, setJobs] = useState<ImportJob[]>([]);
    const [conflicts, setConflicts] = useState<ImportConflict[]>([]);
    const [isImporting, setIsImporting] = useState(false);
    const [isRecovering, setIsRecovering] = useState(true);
    const [recoveryError, setRecoveryError] = useState<string | null>(null);
    const [resolutionBlocked, setResolutionBlocked] = useState(false);
    const busy = useRef(false);
    const blocked = useRef(false);
    const resolvedIds = useRef(new Set<string>());
    const files = useRef(new Map<string, File>());
    const notifier = useRef(createImportNotifier(() => window.dispatchEvent(new Event("media-library-updated"))));

    useEffect(() => {
        let active = true;
        async function recover() {
            try {
                const response = await fetch("/api/import/conflict", { cache: "no-store" });
                if (!response.ok) throw new Error();
                const data = await response.json();
                if (!Array.isArray(data?.conflicts)) throw new Error();
                const restored = data.conflicts.map(readConflict);
                if (active) {
                    setConflicts(restored);
                    setJobs(current => [...current, ...restored.filter((item: ImportConflict) => !current.some(job => job.id === item.jobId)).map((item: ImportConflict): ImportJob => ({
                        id: item.jobId, fileName: item.type === "FILENAME" ? item.existingFilename : "Pending duplicate import",
                        status: "AWAITING_DECISION", progress: 0,
                    }))]);
                }
            } catch {
                if (active) setRecoveryError("Could not restore pending imports. Reload the page to retry.");
            } finally { if (active) setIsRecovering(false); }
        }
        void recover();
        return () => { active = false; };
    }, []);

    function updateJob(job: ImportJob) {
        setJobs(current => current.map(item => item.id === job.id ? job : item));
        if (job.status === "COMPLETED") notifier.current.confirmed(`upload:${job.id}`);
        if (job.status === "COMPLETED" || job.status === "AWAITING_DECISION" || (job.status === "FAILED" && !job.retryable)) files.current.delete(job.id);
    }
    function addConflict(conflict: ImportConflict) {
        setConflicts(current => current.some(item => item.conflictId === conflict.conflictId) ? current : [...current, conflict]);
    }
    async function run(batch: ImportJob[]) {
        try { await processImportQueue(batch, files.current, uploadImportFile, updateJob, addConflict); }
        finally {
            notifier.current.flush();
            busy.current = false;
            setIsImporting(false);
        }
    }
    async function startImport(selected: File[]) {
        if (busy.current || isRecovering || recoveryError || conflicts.length) return;
        busy.current = true;
        setIsImporting(true);
        const created = createImportJobs(selected);
        for (const [id, file] of created.filesByJobId) files.current.set(id, file);
        const batch = applyValidationResults(created.jobs, validateImportJobs(created.jobs, created.filesByJobId));
        for (const job of batch) if (job.status === "FAILED") files.current.delete(job.id);
        setJobs(current => [...current, ...batch]);
        await run(batch);
    }
    async function retryJob(id: string) {
        const job = jobs.find(item => item.id === id);
        if (busy.current || isRecovering || recoveryError || conflicts.length || !job?.retryable || job.status !== "FAILED" || !files.current.has(id)) return;
        busy.current = true;
        setIsImporting(true);
        const retry: ImportJob = { ...job, status: "QUEUED", error: undefined, retryable: false, progress: 0 };
        updateJob(retry);
        await run([retry]);
    }
    function resolved(conflict: ImportConflict, result: ResolveConflictResponse) {
        resolvedIds.current.add(conflict.conflictId);
        setConflicts(current => current.filter(item => item.conflictId !== conflict.conflictId));
        setJobs(current => current.map(job => job.id === conflict.jobId ? {
            ...job, status: result.type === "SKIPPED" ? "SKIPPED" : "COMPLETED",
            progress: result.type === "SKIPPED" ? 0 : 100, error: undefined, retryable: false,
        } : job));
    }
    async function resolveBatch(batch: ImportConflict[], action: ConflictAction) {
        if (busy.current || blocked.current) return;
        busy.current = true;
        try {
            await resolveConflictBatch(batch.filter(item => !resolvedIds.current.has(item.conflictId)), action, resolved, notifier.current);
        } catch (error) {
            // Do not replay an operation whose commit outcome is unknown.
            blocked.current = true;
            setResolutionBlocked(true);
            throw error;
        } finally { notifier.current.flush(); busy.current = false; }
    }
    return {
        jobs, conflicts, isImporting, isRecovering, recoveryError, resolutionBlocked,
        startImport, retryJob,
        resolveConflict: (conflict: ImportConflict, action: ConflictAction) => resolveBatch([conflict], action),
        resolveAllConflicts: (action: ConflictAction) => resolveBatch(conflicts.filter(item => item.type === "FILENAME"), action),
    };
}

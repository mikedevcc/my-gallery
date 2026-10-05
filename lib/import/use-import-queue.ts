"use client";


import { useEffect, useRef, useState } from "react";

import type { ImportJob } from "./import-job";
import type {
    ImportConflict,
    ConflictAction
} from "./import-conflict";
import { createImportJobs } from "./create-import-jobs";
import {
    validateImportJobs,
    applyValidationResults,
} from "./validate-import-jobs";
import { processImportQueue } from "./process-import-queue";
import { uploadImportFile } from "./upload-import-file";
import { resolveImportConflict } from "./resolve-import-conflict";


export function useImportQueue() {
    const [ jobs, setJobs ] = useState<ImportJob[]>([]);
    const [conflicts, setConflicts] = useState<ImportConflict[]>([]);
    const [ isImporting, setIsImporting ] = useState(false);
    const importingRef = useRef(false);
    const [ isRecovering, setIsRecovering ] = useState(true);
    const [ recoveryError, setRecoveryError ] = useState<string | null>(null);
    const [ isResolvingAll, setIsResolvingAll ] = useState(false);
    const resolvingAllRef = useRef(false);

    useEffect(() => {
        let active = true;
        async function recover() {
            try {
                const response = await fetch("/api/import/conflict", { cache: "no-store" });
                if (!response.ok) throw new Error("Could not restore pending imports. Refresh to retry.");
                const data = await response.json() as { conflicts: ImportConflict[] };
                if (active) setConflicts(current => [...current, ...data.conflicts.filter(item => !current.some(other => other.conflictId === item.conflictId))]);
            } catch (error) {
                if (active) setRecoveryError(error instanceof Error ? error.message : "Could not restore pending imports.");
            } finally {
                if (active) setIsRecovering(false);
            }
        }
        void recover();
        return () => { active = false; };
    }, []);


    function updateJob(updatedJob: ImportJob): void {
        setJobs((currentJobs) =>
            currentJobs.map((job) =>
                job.id === updatedJob.id
                    ? updatedJob
                    : job
            )
        );
    }

    function addConflict(conflict: ImportConflict): void {
        console.log("Conflict detected:", conflict);

        setConflicts((currentConflicts) => [
            ...currentConflicts,
            conflict,
        ]);
    }

    async function startImport(files: File[]): Promise<void> {
        if (importingRef.current) {
            return;
        } 

        importingRef.current = true;
        setIsImporting(true);

        try {
            const {
                jobs: createdJobs,
                filesByJobId,
            } = createImportJobs(files);

            setJobs(createdJobs);

            const validationResults = validateImportJobs(createdJobs, filesByJobId);

            const updatedJobs = applyValidationResults(createdJobs, validationResults);

            setJobs(updatedJobs);

            await processImportQueue(
                updatedJobs,
                filesByJobId,
                uploadImportFile,
                updateJob,
                addConflict
            );
        }
        finally{
            importingRef.current = false;
            setIsImporting(false);
        }
    }

    async function resolveConflict(
        conflict: ImportConflict,
        action: ConflictAction
    ): Promise<void> {
        const result = await resolveImportConflict(
            conflict.conflictId,
            action
        );

        setConflicts(current =>
            current.filter(
                item =>
                    item.conflictId !== conflict.conflictId
            )
        );

        setJobs(current =>
            current.map(job => {
                if (job.id !== conflict.jobId) {
                    return job;
                }

                if (result.type === "SKIPPED") {
                    return {
                        ...job,
                        status: "SKIPPED",
                        progress: 0,
                        error: undefined,
                    };
                }

                return {
                    ...job,
                    status: "COMPLETED",
                    progress: 100,
                    error: undefined,
                };
            })
        );
    }

    async function resolveAllConflicts(
        action: ConflictAction
    ): Promise<void> {
        if (isResolvingAll) {
            return;
        }

        setIsResolvingAll(true);

        try {
            const filenameConflicts = conflicts.filter(
                conflict => conflict.type === "FILENAME"
            );

            for (const conflict of filenameConflicts) {
                await resolveConflict(conflict, action);
            }
        }
        finally {
            resolvingAllRef.current = false;
            setIsResolvingAll(false);
        }
    }

    return {
        jobs,
        conflicts,
        isImporting,
        isRecovering,
        recoveryError,
        startImport,
        resolveConflict,
        resolveAllConflicts,
    };
}
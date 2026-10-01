"use client";


import { useRef, useState } from "react";

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

    async function resolveConflict(
        conflict: ImportConflict,
        action: ConflictAction
    ): Promise<void> {
        if (action !== "SKIP") {
            return;
        }

        await resolveImportConflict(
            conflict.conflictId,
            action
        );

        setConflicts((currentConflicts) =>
            currentConflicts.filter(
                (currentConflict) =>
                    currentConflict.conflictId !== conflict.conflictId
            )
        );

        setJobs((currentJobs) =>
            currentJobs.map((job) =>
                job.id === conflict.jobId
                    ? {
                        ...job,
                        status: "SKIPPED",
                        progress: 0,
                    }
                    : job
            )
        );
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

    return {
        jobs,
        conflicts,
        isImporting,
        startImport,
        resolveConflict,
    };
}
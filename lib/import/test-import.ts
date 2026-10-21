import fs from "node:fs/promises";
import path from "node:path";

import { createImportJobs } from "./create-import-jobs";
import {
    validateImportJobs,
    applyValidationResults,
} from "./validate-import-jobs";
import type { ProcessFileResult } from "./process-file-result";
import { processImportQueue } from "./process-import-queue";
import { importMediaToLibrary } from "../../scripts/media-import-service";

async function queueAdapter(
    jobId: string,
    file: File
): Promise<ProcessFileResult> {
    const result = await importMediaToLibrary(file, jobId);

    if (result.type === "COMPLETED") {
        console.log(`Job ${jobId} imported as media ID ${result.mediaId}`);
    } else {
        console.log(`Job ${jobId} requires conflict resolution:`, result.conflict);
    }

    return result;
}

async function fileFromPath(filePath: string): Promise<File> {
    const fileBuffer = await fs.readFile(filePath);

    const file = new File(
        [fileBuffer],
        path.basename(filePath)
    );

    return file
}

async function main(): Promise<void> {
    const testPaths = process.argv.slice(2);
    if (!testPaths.length) throw new Error("Usage: test-import.ts MEDIA_FILE... (imports into configured database and storage)");

    const testFiles = await Promise.all(
        testPaths.map(path => fileFromPath(path))
    );

    const {
        jobs,
        filesByJobId,
    } = createImportJobs(testFiles);

    const validationResults = validateImportJobs(
        jobs,
        filesByJobId
    );

    const validatedJobs = applyValidationResults(
        jobs,
        validationResults
    );

    console.table(
        validatedJobs.map((job) => ({
            fileName: job.fileName,
            status: job.status,
            progress: job.progress,
            error: job.error ?? "",
        }))
    );

    const processedJobs = await processImportQueue(
        validatedJobs,
        filesByJobId,
        queueAdapter,
        (job) => {
            console.log(
                `${job.fileName}: ${job.status} (${job.progress}%)`
            );
        }
    );

    console.table(
        processedJobs.map((job) => ({
            fileName: job.fileName,
            status: job.status,
            progress: job.progress,
            error: job.error ?? "",
        }))
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
import type { ImportJob } from "./import-job";
import type { ImportConflict } from "./import-conflict";


type ProcessFileResult =
    | {
        type: "COMPLETED";
    }
    | {
        type: "CONFLICT";
        conflict: ImportConflict;
    };

type ProcessFile = (
    jobId: string,
    file: File
) => Promise<ProcessFileResult>;

type OnJobUpdate = (job: ImportJob) => void;

type OnConflict = (conflict: ImportConflict) => void;


export async function processImportQueue(
    jobs: ImportJob[],
    filesByJobId: Map<string, File>,
    processFile: ProcessFile,
    onJobUpdate?: OnJobUpdate,
    onConflict?: OnConflict
): Promise<ImportJob[]> {
    const updatedJobs = [...jobs];

    for (let i = 0; i < updatedJobs.length; i++) {
        const job = updatedJobs[i];

        if (job.status !== "QUEUED") {
            continue;
        }

        const file = filesByJobId.get(job.id);

        if (!file) {
            updatedJobs[i] = {
                ...job,
                status: "FAILED",
                error: "Selected file could not be found",
            };

            onJobUpdate?.(updatedJobs[i]);

            continue;
        }

        updatedJobs[i] = {
            ...job,
            status: "PROCESSING",
            progress: 0,
        };

        onJobUpdate?.(updatedJobs[i]);

        try {
            const result = await processFile(job.id, file);

            if (result.type === "CONFLICT") {
                    updatedJobs[i] = {
                    ...updatedJobs[i],
                    status: "AWAITING_DECISION",
                    progress: 0,
                };

                onJobUpdate?.(updatedJobs[i]);
                onConflict?.(result.conflict);

                continue;
            }

            updatedJobs[i] = {
                ...updatedJobs[i],
                status: "COMPLETED",
                progress: 100,
                error: undefined,
            };

            onJobUpdate?.(updatedJobs[i]);
        } catch (error) {
            updatedJobs[i] = {
                ...updatedJobs[i],
                status: "FAILED",
                progress: 0,
                error:
                    error instanceof Error
                        ? error.message
                        : "Unknown import error",
            };

            onJobUpdate?.(updatedJobs[i]);
        }
    }

    return updatedJobs;
}



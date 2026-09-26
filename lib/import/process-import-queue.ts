import type { ImportJob } from "./import-job";


type ProcessFile = (
    jobId: string,
    file: File
) => Promise<void>;

type OnJobUpdate = (job: ImportJob) => void;

export async function processImportQueue(
    jobs: ImportJob[],
    filesByJobId: Map<string, File>,
    processFile: ProcessFile,
    onJobUpdate?: OnJobUpdate
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
            await processFile(job.id, file);

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



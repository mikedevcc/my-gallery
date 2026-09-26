import type { ImportJob } from "./import-job";


type CreatedImportJobs = {
    jobs: ImportJob[];
    filesByJobId: Map<string, File>;
};


export function createImportJobs(
    files: File[]
): CreatedImportJobs {
    const jobs: ImportJob[] = [];
    const filesByJobId = new Map<string, File>();

    for (const file of files) {
        const id = crypto.randomUUID();

        jobs.push({
            id,
            fileName: file.name,
            status: "VERIFYING",
            progress: 0,
        });

        filesByJobId.set(id, file);
    }

    return {
        jobs,
        filesByJobId,
    };
}
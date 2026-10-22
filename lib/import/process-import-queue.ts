import type { ImportJob } from "./import-job";
import type { PublicImportConflict } from "./import-conflict";
import type { ProcessFileResult } from "./process-file-result";
import { importFailure } from "./import-feedback";

export async function processImportQueue(
    jobs: ImportJob[], filesByJobId: Map<string, File>,
    processFile: (jobId: string, file: File) => Promise<ProcessFileResult>,
    onJobUpdate?: (job: ImportJob) => void,
    onConflict?: (conflict: PublicImportConflict) => void,
): Promise<ImportJob[]> {
    const updated = [...jobs];
    for (let i = 0; i < updated.length; i++) {
        const job = updated[i];
        if (job.status !== "QUEUED") continue;
        const file = filesByJobId.get(job.id);
        if (!file) {
            updated[i] = { ...job, status: "FAILED", error: "Selected file could not be found", retryable: false };
            onJobUpdate?.(updated[i]);
            continue;
        }
        updated[i] = { ...job, status: "PROCESSING", progress: 0, error: undefined, retryable: false };
        onJobUpdate?.(updated[i]);
        let result: ProcessFileResult;
        try { result = await processFile(job.id, file); }
        catch (error) {
            const failure = importFailure(error);
            updated[i] = { ...job, status: "FAILED", progress: 0, error: failure.message, retryable: failure.retryable };
            onJobUpdate?.(updated[i]);
            continue;
        }
        // UI callbacks must never turn a confirmed server success into a retryable failure.
        updated[i] = { ...job, status: result.type === "CONFLICT" ? "AWAITING_DECISION" : "COMPLETED", progress: result.type === "CONFLICT" ? 0 : 100, error: undefined, retryable: false };
        onJobUpdate?.(updated[i]);
        if (result.type === "CONFLICT") onConflict?.(result.conflict);
    }
    return updated;
}

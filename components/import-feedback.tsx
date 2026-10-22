import type { ImportJob, ImportStatus } from "../lib/import/import-job";

const labels: Record<ImportStatus, string> = {
    VERIFYING: "Checking", QUEUED: "Pending", UPLOADING: "Uploading",
    PROCESSING: "Uploading / processing", AWAITING_DECISION: "Awaiting conflict resolution",
    COMPLETED: "Imported", FAILED: "Failed", SKIPPED: "Skipped",
};

export function ImportFeedback({ jobs, disabled, onRetry }: {
    jobs: ImportJob[]; disabled: boolean; onRetry: (id: string) => void;
}) {
    if (!jobs.length) return null;
    return (
        <details className="import-feedback" open>
            <summary>
                Imports: {jobs.filter(job => job.status === "COMPLETED").length} completed,
                {" "}{jobs.filter(job => job.status === "FAILED").length} failed,
                {" "}{jobs.filter(job => job.status === "AWAITING_DECISION").length} awaiting resolution
            </summary>
            <ul aria-live="polite" aria-label="Import results">
                {jobs.map(job => <li key={job.id}>
                    <strong>{job.fileName}</strong>{": "}{labels[job.status]}
                    {job.error && <p>{job.error}</p>}
                    {job.status === "FAILED" && job.retryable && (
                        <button type="button" disabled={disabled} onClick={() => onRetry(job.id)}>Retry {job.fileName}</button>
                    )}
                </li>)}
            </ul>
        </details>
    );
}

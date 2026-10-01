export type ImportStatus =
    | "VERIFYING"
    | "QUEUED"
    | "UPLOADING"
    | "PROCESSING"
    | "AWAITING_DECISION"
    | "COMPLETED"
    | "FAILED"
    | "SKIPPED";

export type ImportJob = {
    id: string;
    fileName: string;
    status: ImportStatus;
    progress: number;
    error?: string;
};
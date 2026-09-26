export type ImportStatus =
    | "VERIFYING"
    | "QUEUED"
    | "UPLOADING"
    | "PROCESSING"
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


const testJob: ImportJob = {
    id: "123",
    fileName: "photo.jpg",
    status: "VERIFYING",
    progress: 0,
};
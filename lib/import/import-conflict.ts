export type ConflictAction =
    | "SKIP"
    | "KEEP_BOTH"
    | "REPLACE";

export type FilenameConflict = {
    type: "FILENAME";
    jobId: string;
    conflictId: string;
    existingMediaId?: number;
    existingPath: string;
};

export type HashConflict = {
    type: "HASH";
    jobId: string;
    conflictId: string;
    existingMediaId: number;
};

export type ImportConflict =
    | FilenameConflict
    | HashConflict;

// Browser/API contract. Internal pending conflicts retain existingPath for recovery.
export type PublicImportConflict =
    | (Omit<FilenameConflict, "existingPath"> & { existingFilename: string })
    | HashConflict;

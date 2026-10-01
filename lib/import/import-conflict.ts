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
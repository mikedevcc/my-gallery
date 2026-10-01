import type { ImportConflict } from "./import-conflict";

export type ProcessFileResult =
    | {
        type: "COMPLETED";
    }
    | {
        type: "CONFLICT";
        conflict: ImportConflict;
    };
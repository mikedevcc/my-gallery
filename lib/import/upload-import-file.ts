import { unsupportedMediaMessage } from "../media-formats";
import type { ProcessFileResult } from "./process-file-result";
import { ImportFailure, importFailure, readConflict, uncertainImport } from "./import-feedback";

export async function uploadImportFile(jobId: string, file: File): Promise<ProcessFileResult> {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("jobId", jobId);
    formData.append("fileLastModified", String(file.lastModified));
    try {
        const response = await fetch("/api/import", { method: "POST", body: formData });
        if (response.status === 503 && response.headers.get("X-Import-Retry-Safe") === "1") {
            throw new ImportFailure("Import processing is unavailable. Nothing was imported; retry when the server is ready.", true);
        }
        if (response.status === 413) throw new ImportFailure("This file exceeds the upload limit. Choose a smaller file.");
        if (response.status === 415) throw new ImportFailure(unsupportedMediaMessage);
        const data = await response.json();
        if (response.status === 409 && data?.conflict) return { type: "CONFLICT", conflict: readConflict(data.conflict) };
        if (!response.ok || !Number.isSafeInteger(data?.mediaId) || data.mediaId <= 0) throw new ImportFailure(uncertainImport);
        return { type: "COMPLETED" };
    } catch (error) { throw importFailure(error); }
}

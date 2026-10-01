import type { ImportConflict } from "./import-conflict";
import type { ProcessFileResult } from "./process-file-result";

type ImportResponse = {
    message?: string;
    mediaId?: number;
    error?: string;
    conflict?: ImportConflict;
};


export async function uploadImportFile(
    jobId: string,
    file: File
): Promise<ProcessFileResult> {
    const formData = new FormData();

    formData.append("file", file);
    formData.append("jobId", jobId);

    const response =  await fetch("/api/import", {
        method: "POST",
        body: formData,
    });

    const data = await response.json() as ImportResponse;

    if (response.status === 409 && data.conflict) {
        return {
            type: "CONFLICT",
            conflict: data.conflict,
        }
    }

    if (!response.ok) {
        throw new Error(
            data.error ?? `Import failed with status ${response.status}`
        );
    }

    console.log(
        `Job ${jobId} imported as media ID ${data.mediaId}`
    );

    return {
        type: "COMPLETED",
    };
}
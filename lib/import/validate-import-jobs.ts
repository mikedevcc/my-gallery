import { ImportJob } from "./import-job";

type ValidationResult = {
    jobId: string;
    valid: boolean;
    error?: string;
};


const imageExtensions = [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".heif",
    ".tiff",
    ".webp",
    ".avif",
];

const videoExtensions = [
    ".mp4",
    ".mov",
    ".avi",
    ".mkv",
    ".webm",
    ".wmv",
];


function getExtension(fileName: string): string {
    const lastDot = fileName.lastIndexOf(".");

    if (lastDot === -1) {
        return "";
    }

    return fileName.slice(lastDot).toLowerCase();
}


export function validateImportJobs(
    jobs: ImportJob[],
    filesByJobId: Map<string, File>
): ValidationResult[] {
    const results: ValidationResult[] = [];

    for (const job of jobs) {
        const file = filesByJobId.get(job.id);

        if (!file) {
            results.push({
                jobId: job.id,
                valid: false,
                error: "Selected file could not be found",
            });

            continue;
        }

        if (file.size <= 0) {
            results.push({
                jobId: job.id,
                valid: false,
                error: "File is empty",
            });

            continue;
        }

        const extension = getExtension(file.name);

        const supported =
            imageExtensions.includes(extension) ||
            videoExtensions.includes(extension);

        if (!supported) {
            results.push({
                jobId: job.id,
                valid: false,
                error: `Unsupported file type: ${extension}`,
            });

            continue;
        }

        results.push({
            jobId: job.id,
            valid: true,
        });
    }

    return results;
}


export function applyValidationResults (
    jobs: ImportJob[],
    results: ValidationResult[]
): ImportJob[] {
    return jobs.map((job) => {
        const result = results.find(
            (result) => result.jobId === job.id
        );
        
        if (!result) {
            return {
                ...job,
                status: "FAILED",
                error: "Vaidation result missing",
            };
        }

        if (!result.valid) {
            return {
                ...job,
                status: "FAILED",
                error: result.error,
            };
        }

        return {
            ...job,
            status: "QUEUED",
            error: undefined,
        };
    });
}
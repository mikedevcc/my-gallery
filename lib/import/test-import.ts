import { createImportJobs } from "./create-import-jobs";
import {
    validateImportJobs,
    applyValidationResults,
} from "./validate-import-jobs";
import { processImportQueue } from "./process-import-queue";

const testFiles = [
    new File(["image data"], "photo.jpg", {
        type: "image/jpeg",
    }),
    new File(["video data"], "movie.mp4", {
        type: "video/mp4",
    }),
    new File(["text"], "notes.txt", {
        type: "text/plain",
    }),
    new File([], "empty.jpg", {
        type: "image/jpeg",
    }),
];

const {
    jobs,
    filesByJobId,
} = createImportJobs(testFiles);

console.log("Before validation:");
console.log(jobs);

const validationResults = validateImportJobs(
    jobs,
    filesByJobId
);

console.log("Validation results:");
console.log(validationResults);

const validatedJobs = applyValidationResults(
    jobs,
    validationResults
);

console.log("After validation:");
console.log(validatedJobs);

async function fakeProcessFile(
    jobId: string,
    file: File
): Promise<void> {
    console.log(`Processing ${file.name}`);

    await new Promise((resolve) =>
        setTimeout(resolve, 500)
    );

    if (file.name.includes("fail")) {
        throw new Error("Simulated import failure");
    }
}

async function main(): Promise<void> {
    const testFiles = [
        new File(["image data"], "photo.jpg", {
            type: "image/jpeg",
        }),
        new File(["video data"], "movie.mp4", {
            type: "video/mp4",
        }),
        new File(["text"], "notes.txt", {
            type: "text/plain",
        }),
        new File([], "empty.jpg", {
            type: "image/jpeg",
        }),
        new File(["bad image"], "fail.jpg", {
            type: "image/jpeg",
        }),
    ];

    const {
        jobs,
        filesByJobId,
    } = createImportJobs(testFiles);

    const validationResults = validateImportJobs(
        jobs,
        filesByJobId
    );

    const validatedJobs = applyValidationResults(
        jobs,
        validationResults
    );

    console.table(
        validatedJobs.map((job) => ({
            fileName: job.fileName,
            status: job.status,
            progress: job.progress,
            error: job.error ?? "",
        }))
    );

    const processedJobs = await processImportQueue(
        validatedJobs,
        filesByJobId,
        fakeProcessFile,
        (job) => {
            console.log(
                `${job.fileName}: ${job.status} (${job.progress}%)`
            );
        }
    );

    console.table(
        processedJobs.map((job) => ({
            fileName: job.fileName,
            status: job.status,
            progress: job.progress,
            error: job.error ?? "",
        }))
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
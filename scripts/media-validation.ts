type ValidationResult = {
    sourcePath: string;
    valid: boolean;
    reason?: string;
};


async function validateMediaCandidate(
    sourcePath: string
): Promise<ValidationResult> {
    
    
    return result;
}


async function validateMediaCandidates(
    sourcePaths: string
): Promise<ValidationResult> {
    const results: ValidationResult[] = [];

    for (const sourcePath of sourcePaths) {
        results.push(
            await validateMediaCandidate(sourcePath)
        );
    }

    return results;
}
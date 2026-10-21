import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { AdmissionGate, ProcessingError, processingLimits, processingSignal } from "./processing-limits";

const gate = new AdmissionGate();
/** No shell; retain admission until the child exits, including timeout/abort teardown. */
export async function runMediaSubprocess(command: string, args: string[], options: { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<{ stdout: string }> {
    const limits = processingLimits();
    const signal = options.signal ?? processingSignal();
    return gate.run(limits.subprocesses, () => new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new ProcessingError("Media processing cancelled", 408)); return; }
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
        let failure: Error | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let stdout = "";
        const decoder = new StringDecoder("utf8");
        let bytes = 0;
        const kill = (kind: NodeJS.Signals) => {
            try {
                if (process.platform !== "win32" && child.pid) process.kill(-child.pid, kind);
                else child.kill(kind);
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error as Error; }
        };
        const stop = (error: Error) => {
            if (failure) return;
            failure = error;
            kill("SIGTERM");
            killTimer = setTimeout(() => kill("SIGKILL"), 1000);
        };
        const abort = () => stop(new ProcessingError("Media processing cancelled", 408));
        signal?.addEventListener("abort", abort, { once: true });
        // Close the race between the initial check and listener registration.
        if (signal?.aborted) abort();
        const timer = setTimeout(() => stop(new ProcessingError(`${command} timed out`, 504)), options.timeoutMs ?? limits.subprocessMs);
        child.stdout.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > (options.maxOutputBytes ?? limits.outputBytes)) stop(new ProcessingError(`${command} output limit exceeded`, 422));
            else stdout += decoder.write(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > (options.maxOutputBytes ?? limits.outputBytes)) stop(new ProcessingError(`${command} output limit exceeded`, 422));
        });
        child.on("error", error => { failure ??= error; });
        child.on("close", code => {
            clearTimeout(timer);
            // Kill descendants too when cancellation terminated their parent first.
            if (failure) kill("SIGKILL");
            if (killTimer) clearTimeout(killTimer);
            signal?.removeEventListener("abort", abort);
            if (failure) reject(failure);
            else if (code !== 0) reject(new ProcessingError(`${command} failed (exit ${code})`, 422));
            else resolve({ stdout: stdout + decoder.end() });
        });
    }));
}

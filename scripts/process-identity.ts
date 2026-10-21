import fs from "node:fs/promises";

export type ProcessIdentity = { pid: number; uid: number; bootId: string; startTime: string };
export async function processIdentity(pid = process.pid): Promise<ProcessIdentity> {
    const bootId = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (!/^\d+$/.test(fields[19])) throw new Error("Cannot verify Linux process identity");
    const uid = (await fs.stat(`/proc/${pid}`)).uid;
    return { pid, uid, bootId, startTime: fields[19] };
}
export async function processHasStopped(owner: Partial<ProcessIdentity>): Promise<boolean> {
    if (!Number.isSafeInteger(owner.pid) || !owner.bootId || !owner.startTime) throw new Error("Legacy lock has no verifiable process identity; manual investigation required");
    if (!Number.isSafeInteger(owner.uid) || owner.uid !== process.getuid?.()) throw new Error("Recovery must run as the same Unix user as the owner; process visibility cannot be proven");
    const boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (boot !== owner.bootId) return true;
    try { return (await processIdentity(owner.pid)).startTime !== owner.startTime; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

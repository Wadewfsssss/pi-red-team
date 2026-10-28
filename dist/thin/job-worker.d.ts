export declare function processIdentity(pid: number): Promise<{
    pid: number;
    startTicks: string;
    bootId: string;
    hostname: string;
}>;

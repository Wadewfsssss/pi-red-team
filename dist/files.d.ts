export declare function digest(value: string | Buffer): string;
export declare function safePath(root: string, ...parts: string[]): string;
export declare function rejectSymlinks(root: string, path: string): Promise<void>;
export declare function atomicWrite(path: string, value: string | Buffer): Promise<void>;

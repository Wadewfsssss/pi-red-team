export declare function readOutputWindow(path: string, offset: number, maxBytes: number, terminal: boolean): Promise<{
    text: string;
    nextOffset: number;
    bytesRead: number;
    outputBytes: number;
    atEnd: boolean;
    pendingUtf8Bytes: number;
}>;

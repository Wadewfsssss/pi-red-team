import { constants } from "node:fs";
import { open } from "node:fs/promises";

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function utf8SequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

function completeUtf8End(buffer: Buffer, start: number, end: number): number {
  let index = end - 1;
  let inspected = 0;
  while (index >= start && inspected < 4) {
    const byte = buffer.readUInt8(index);
    if (!isUtf8Continuation(byte)) return index + utf8SequenceLength(byte) <= end ? end : index;
    index -= 1;
    inspected += 1;
  }
  return end;
}

export async function readOutputWindow(path: string, offset: number, maxBytes: number, terminal: boolean) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || offset > info.size) throw new Error("Output is not a regular file or cursor is out of range");
    const buffer = Buffer.alloc(Math.min(maxBytes, info.size - offset));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (bytesRead && offset && isUtf8Continuation(buffer[0]!)) throw new Error("Cursor splits a UTF-8 sequence");
    const end = terminal && offset + bytesRead === info.size ? bytesRead : completeUtf8End(buffer, 0, bytesRead);
    return { text: buffer.subarray(0, end).toString("utf8"), nextOffset: offset + end, bytesRead: end, outputBytes: info.size, atEnd: offset + end === info.size, pendingUtf8Bytes: bytesRead - end };
  } finally { await file.close(); }
}

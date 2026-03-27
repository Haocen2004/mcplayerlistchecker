/**
 * Custom compression module that monkey-patches minecraft-protocol's
 * compression transforms to support both zlib (default) and zstd.
 *
 * Usage: call applyCompression('zstd') before mc.createClient()
 */

import { Transform } from 'stream';
import * as zlib from 'zlib';

// Lazy-loaded zstd to avoid hard dependency when not used
let zstd: typeof import('zstd-napi') | null = null;

function getZstd() {
    if (!zstd) {
        zstd = require('zstd-napi');
    }
    return zstd!;
}

// Re-create the varint helpers matching protodef's implementation
function readVarInt(buffer: Buffer, offset: number): { size: number; value: number; error?: Error } {
    let result = 0;
    let shift = 0;
    let cursor = offset;
    while (cursor < buffer.length) {
        const b = buffer[cursor++];
        result |= (b & 0x7f) << shift;
        if (!(b & 0x80)) {
            return { size: cursor - offset, value: result };
        }
        shift += 7;
        if (shift >= 32) {
            return { size: 0, value: 0, error: new Error('VarInt too big') };
        }
    }
    return { size: 0, value: 0, error: new Error('VarInt incomplete') };
}

function writeVarInt(value: number, buffer: Buffer, offset: number): number {
    let cursor = offset;
    while (true) {
        let b = value & 0x7f;
        value >>>= 7;
        if (value === 0) {
            buffer[cursor++] = b;
            break;
        } else {
            buffer[cursor++] = b | 0x80;
        }
    }
    return cursor;
}

function sizeOfVarInt(value: number): number {
    let size = 0;
    do {
        value >>>= 7;
        size++;
    } while (value !== 0);
    return size;
}

export type CompressionType = 'zlib' | 'zstd';

class ZstdCompressor extends Transform {
    public compressionThreshold: number;

    constructor(threshold: number) {
        super();
        this.compressionThreshold = threshold;
    }

    _transform(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
        if (chunk.length >= this.compressionThreshold) {
            try {
                const compressed = getZstd().compress(chunk);
                const buf = Buffer.alloc(sizeOfVarInt(chunk.length) + compressed.length);
                const offset = writeVarInt(chunk.length, buf, 0);
                compressed.copy(buf, offset);
                this.push(buf);
                return cb();
            } catch (err) {
                return cb(err as Error);
            }
        } else {
            const buf = Buffer.alloc(sizeOfVarInt(0) + chunk.length);
            const offset = writeVarInt(0, buf, 0);
            chunk.copy(buf, offset);
            this.push(buf);
            return cb();
        }
    }
}

class ZstdDecompressor extends Transform {
    public compressionThreshold: number;
    private hideErrors: boolean;

    constructor(threshold: number, hideErrors: boolean) {
        super();
        this.compressionThreshold = threshold;
        this.hideErrors = hideErrors;
    }

    _transform(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
        const { size, value, error } = readVarInt(chunk, 0);
        if (error) return cb(error);

        if (value === 0) {
            this.push(chunk.slice(size));
            return cb();
        } else {
            try {
                const decompressed = getZstd().decompress(chunk.slice(size));
                if (decompressed.length !== value && !this.hideErrors) {
                    console.error(`[zstd] uncompressed length should be ${value} but is ${decompressed.length}`);
                }
                this.push(decompressed);
                return cb();
            } catch (err) {
                if (!this.hideErrors) {
                    console.error('[zstd] problem decompressing chunk');
                    console.error('uncompressed length ' + value);
                    console.error('compressed length ' + chunk.length);
                    console.error(err);
                }
                return cb();
            }
        }
    }
}

/**
 * Monkey-patches minecraft-protocol's compression module to use the specified algorithm.
 * Must be called BEFORE mc.createClient().
 */
export function applyCompression(type: CompressionType): void {
    if (type === 'zlib') {
        // Default behavior, no patching needed
        return;
    }

    if (type === 'zstd') {
        // Verify zstd is available
        getZstd();

        // Monkey-patch the compression module used by minecraft-protocol
        const compression = require('minecraft-protocol/src/transforms/compression');
        compression.createCompressor = function (threshold: number) {
            return new ZstdCompressor(threshold);
        };
        compression.createDecompressor = function (threshold: number, hideErrors: boolean) {
            return new ZstdDecompressor(threshold, hideErrors);
        };

        console.log('[Compression] Using zstd compression');
    }
}

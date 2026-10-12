/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface Segment {
    /** byte offset in the recording */
    offset: number;
    /** seconds into the recording when this segment was written, never earlier than its media time */
    time: number;
}

interface Element {
    header: number;
    size: number;
    /** a media segment starts here (MP4 moof, WebM Cluster) */
    segment: boolean;
    /** continue with this element's children instead of skipping it */
    enter: boolean;
}

const EMPTY = new Uint8Array(0);
const UNKNOWN = Number.MAX_SAFE_INTEGER;
const MAX_INIT = 4 * 1024 * 1024;

function concat(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>) {
    if (!a.length) return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

function readBox(buf: Uint8Array): Element | null {
    if (buf.length < 8) return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const type = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
    let size = view.getUint32(0);
    let header = 8;
    if (size === 1) {
        if (buf.length < 16) return null;
        size = Number(view.getBigUint64(8));
        header = 16;
    } else if (size === 0) {
        size = UNKNOWN;
    }
    return { header, size: size - header, segment: type === "moof", enter: false };
}

function readVint(buf: Uint8Array, pos: number, keepMarker: boolean) {
    if (pos >= buf.length) return null;
    const length = Math.clz32(buf[pos]) - 23;
    if (length > 8) throw new Error("Invalid EBML number");
    if (pos + length > buf.length) return null;

    let value = keepMarker ? buf[pos] : buf[pos] & (0xff >> length);
    let allOnes = value === (0xff >> length);
    for (let i = 1; i < length; i++) {
        value = value * 256 + buf[pos + i];
        allOnes &&= buf[pos + i] === 0xff;
    }
    return { length, value: !keepMarker && allOnes ? UNKNOWN : value };
}

function readEbml(buf: Uint8Array): Element | null {
    const id = readVint(buf, 0, true);
    if (!id) return null;
    const size = readVint(buf, id.length, false);
    if (!size) return null;

    const segment = id.value === 0x1F43B675;
    return {
        header: id.length + size.length,
        size: size.value,
        segment,
        // the Segment itself, and live clusters which have no size so their end is only known from what follows
        enter: id.value === 0x18538067 || segment && size.value === UNKNOWN
    };
}

/**
 * Finds where each media segment starts while the recording streams by, so the preview can begin playback from
 * any of them. Everything before the first segment is the init segment that every playback has to start with.
 */
export class SegmentIndex {
    init: Uint8Array<ArrayBuffer> | null = null;
    segments: Segment[] = [];

    private head = EMPTY;
    /** unparsed bytes from `pos` on */
    private buf = EMPTY;
    /** where the next element header starts */
    private pos = 0;
    private total = 0;
    private broken = false;

    constructor(private readonly webm: boolean) { }

    push(data: Uint8Array<ArrayBuffer>, time: number) {
        if (this.broken) return;
        try {
            this.parse(data, time);
        } catch {
            // Corrupt or not what we expected, keep the segments found so far
            this.broken = true;
            this.buf = this.head = EMPTY;
        }
    }

    private parse(data: Uint8Array<ArrayBuffer>, time: number) {
        const start = this.total;
        this.total += data.length;
        if (!this.init) {
            this.head = concat(this.head, data);
            if (this.head.length > MAX_INIT) throw new Error("No media segment found");
        }

        if (this.pos >= this.total) return;
        this.buf = this.pos <= start ? concat(this.buf, data) : data.subarray(this.pos - start);

        while (this.buf.length) {
            const element = this.webm ? readEbml(this.buf) : readBox(this.buf);
            if (!element) break;
            if (element.size < 0) throw new Error("Invalid element size");

            if (element.segment) {
                if (!this.init) {
                    this.init = this.head.slice(0, this.pos);
                    this.head = EMPTY;
                }
                this.segments.push({ offset: this.pos, time });
            }

            const skip = element.enter ? element.header : element.header + element.size;
            this.pos += skip;
            this.buf = skip < this.buf.length ? this.buf.subarray(skip) : EMPTY;
        }
    }

    /** The last segment written at or before `time`, which therefore starts at or before it */
    find(time: number) {
        let found = this.segments[0];
        for (const segment of this.segments) {
            if (segment.time > time) break;
            found = segment;
        }
        return found;
    }
}

/** MSE wants the exact H.264 profile, which MediaRecorder's mime type leaves out */
export function getSourceBufferType(mimeType: string, init: Uint8Array) {
    if (!mimeType.includes("avc1")) return mimeType;

    for (let i = 4; i + 8 <= init.length; i++) {
        if (init[i] === 0x61 && init[i + 1] === 0x76 && init[i + 2] === 0x63 && init[i + 3] === 0x43) { // avcC
            const hex = (byte: number) => byte.toString(16).padStart(2, "0");
            return mimeType.replace("avc1", `avc1.${hex(init[i + 5])}${hex(init[i + 6])}${hex(init[i + 7])}`);
        }
    }
    return mimeType;
}

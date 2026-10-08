/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type FileHandle, open, rename, rm } from "fs/promises";

interface BoxRef {
    type: string;
    start: number;
    end: number;
    body: number;
}

interface Chunk {
    offset: number;
    size: number;
    count: number;
    target: number;
}

interface Track {
    ref: BoxRef;
    timescale: number;
    defaults: number[];
    sizes: number[];
    durations: number[];
    compositionOffsets: number[];
    syncSamples: number[];
    chunks: Chunk[];
    time: number;
}

function children(buf: Buffer, start: number, end: number) {
    const boxes: BoxRef[] = [];
    for (let pos = start; pos + 8 <= end;) {
        const size = buf.readUInt32BE(pos);
        if (size < 8 || pos + size > end) break;
        boxes.push({ type: buf.toString("latin1", pos + 4, pos + 8), start: pos, end: pos + size, body: pos + 8 });
        pos += size;
    }
    return boxes;
}

function child(buf: Buffer, parent: BoxRef, type: string) {
    const found = children(buf, parent.body, parent.end).find(b => b.type === type);
    if (!found) throw new Error(`Missing ${type} box`);
    return found;
}

function box(type: string, ...parts: Buffer[]) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + parts.reduce((size, part) => size + part.length, 0));
    header.write(type, 4, "latin1");
    return Buffer.concat([header, ...parts]);
}

function table(type: string, values: number[], count: number, prefix: number[] = [], version = 0) {
    const buf = Buffer.alloc(16 + (prefix.length + values.length) * 4);
    buf.writeUInt32BE(buf.length);
    buf.write(type, 4, "latin1");
    buf.writeUInt32BE((version << 24) >>> 0, 8);
    let pos = 12;
    for (const value of prefix) pos = buf.writeUInt32BE(value >>> 0, pos);
    pos = buf.writeUInt32BE(count, pos);
    for (const value of values) pos = buf.writeUInt32BE(value >>> 0, pos);
    return buf;
}

function chunkOffsets(offsets: number[], large: boolean) {
    if (!large) return table("stco", offsets, offsets.length);

    const buf = Buffer.alloc(16 + offsets.length * 8);
    buf.writeUInt32BE(buf.length);
    buf.write("co64", 4, "latin1");
    buf.writeUInt32BE(offsets.length, 12);
    offsets.forEach((offset, i) => buf.writeBigUInt64BE(BigInt(offset), 16 + i * 8));
    return buf;
}

function runLength(values: number[]) {
    const entries: number[] = [];
    for (const value of values) {
        if (entries.length && entries[entries.length - 1] === value) entries[entries.length - 2]++;
        else entries.push(1, value);
    }
    return entries;
}

function withDuration(buf: Buffer, ref: BoxRef, duration: number, offsetV0: number, offsetV1: number) {
    const copy = Buffer.from(buf.subarray(ref.start, ref.end));
    if (copy[8]) copy.writeBigUInt64BE(BigInt(duration), offsetV1);
    else copy.writeUInt32BE(duration, offsetV0);
    return copy;
}

function rebuild(buf: Buffer, ref: BoxRef, replace: Record<string, (ref: BoxRef) => Buffer>): Buffer {
    return box(ref.type, ...children(buf, ref.body, ref.end).map(c => replace[c.type]?.(c) ?? buf.subarray(c.start, c.end)));
}

async function read(file: FileHandle, position: number, length: number) {
    const buf = Buffer.alloc(length);
    await file.read(buf, 0, length, position);
    return buf;
}

function parseMoof(moof: Buffer, moofStart: number, tracks: Map<number, Track>, fileSize: number) {
    for (const traf of children(moof, 8, moof.length).filter(b => b.type === "traf")) {
        const tfhd = child(moof, traf, "tfhd");
        const flags = moof.readUInt32BE(tfhd.body) & 0xffffff;
        const track = tracks.get(moof.readUInt32BE(tfhd.body + 4));
        if (!track) throw new Error("Fragment references an unknown track");

        let pos = tfhd.body + 8;
        let base = moofStart;
        if (flags & 0x1) {
            base = Number(moof.readBigUInt64BE(pos));
            pos += 8;
        }
        if (flags & 0x2) pos += 4;
        let [defaultDuration, defaultSize, defaultFlags] = track.defaults;
        if (flags & 0x8) {
            defaultDuration = moof.readUInt32BE(pos);
            pos += 4;
        }
        if (flags & 0x10) {
            defaultSize = moof.readUInt32BE(pos);
            pos += 4;
        }
        if (flags & 0x20) defaultFlags = moof.readUInt32BE(pos);

        const tfdt = children(moof, traf.body, traf.end).find(b => b.type === "tfdt");
        if (tfdt) {
            const time = moof[tfdt.body] ? Number(moof.readBigUInt64BE(tfdt.body + 4)) : moof.readUInt32BE(tfdt.body + 4);
            const last = track.durations.length - 1;
            if (last >= 0) track.durations[last] = Math.max(1, track.durations[last] + time - track.time);
            track.time = time;
        }

        let offset = base;
        for (const trun of children(moof, traf.body, traf.end).filter(b => b.type === "trun")) {
            const version = moof[trun.body];
            const trunFlags = moof.readUInt32BE(trun.body) & 0xffffff;
            const count = moof.readUInt32BE(trun.body + 4);
            let p = trun.body + 8;
            if (trunFlags & 0x1) {
                offset = base + moof.readInt32BE(p);
                p += 4;
            }
            let firstFlags = defaultFlags;
            if (trunFlags & 0x4) {
                firstFlags = moof.readUInt32BE(p);
                p += 4;
            }

            const chunk: Chunk = { offset, size: 0, count, target: 0 };
            for (let i = 0; i < count; i++) {
                const duration = trunFlags & 0x100 ? moof.readUInt32BE(p) : defaultDuration;
                if (trunFlags & 0x100) p += 4;
                const size = trunFlags & 0x200 ? moof.readUInt32BE(p) : defaultSize;
                if (trunFlags & 0x200) p += 4;
                const sampleFlags = trunFlags & 0x400 ? moof.readUInt32BE(p) : i === 0 ? firstFlags : defaultFlags;
                if (trunFlags & 0x400) p += 4;
                const compositionOffset = !(trunFlags & 0x800) ? 0 : version ? moof.readInt32BE(p) : moof.readUInt32BE(p);
                if (trunFlags & 0x800) p += 4;

                track.durations.push(duration);
                track.sizes.push(size);
                track.compositionOffsets.push(compositionOffset);
                if (!(sampleFlags & 0x10000)) track.syncSamples.push(track.sizes.length);
                track.time += duration;
                chunk.size += size;
            }

            if (chunk.offset + chunk.size > fileSize) throw new Error("Fragment data is past the end of the file");
            if (count) track.chunks.push(chunk);
            offset += chunk.size;
        }
    }
}

// MediaRecorder writes fragmented MP4 with no duration and no seek index, which makes players like VLC
// show garbage after seeking. This rewrites it into a regular MP4 without touching the encoded data.
export async function defragment(path: string) {
    const input = await open(path, "r");
    const tmp = `${path}.tmp`;

    try {
        const { size: fileSize } = await input.stat();
        const tracks = new Map<number, Track>();
        let moov: Buffer | undefined;

        for (let pos = 0; pos + 8 <= fileSize;) {
            const header = await read(input, pos, 16);
            const size = header.readUInt32BE(0) === 1 ? Number(header.readBigUInt64BE(8)) : header.readUInt32BE(0);
            if (size < 8 || pos + size > fileSize) break;

            const type = header.toString("latin1", 4, 8);
            if (type === "moov") {
                const buf = moov = await read(input, pos, size);
                const mvex = child(buf, { type, start: 0, end: size, body: 8 }, "mvex");
                const trex = children(buf, mvex.body, mvex.end).filter(b => b.type === "trex");
                for (const trak of children(buf, 8, size).filter(b => b.type === "trak")) {
                    const tkhd = child(buf, trak, "tkhd");
                    const mdhd = child(buf, child(buf, trak, "mdia"), "mdhd");
                    const id = buf.readUInt32BE(tkhd.body + (buf[tkhd.body] ? 20 : 12));
                    const defaults = trex.find(b => buf.readUInt32BE(b.body + 4) === id);
                    tracks.set(id, {
                        ref: trak,
                        timescale: buf.readUInt32BE(mdhd.body + (buf[mdhd.body] ? 20 : 12)),
                        defaults: defaults ? [12, 16, 20].map(o => buf.readUInt32BE(defaults.body + o)) : [0, 0, 0],
                        sizes: [],
                        durations: [],
                        compositionOffsets: [],
                        syncSamples: [],
                        chunks: [],
                        time: 0
                    });
                }
            } else if (type === "moof") {
                parseMoof(await read(input, pos, size), pos, tracks, fileSize);
            }

            pos += size;
        }

        const chunks = [...tracks.values()].flatMap(t => t.chunks).sort((a, b) => a.offset - b.offset);
        if (!moov || !chunks.length) throw new Error("Recording has no media");

        let payload = 0;
        for (const chunk of chunks) {
            chunk.target = payload;
            payload += chunk.size;
        }

        const source = moov;
        const root = { type: "moov", start: 0, end: source.length, body: 8 };
        const mvhd = child(source, root, "mvhd");
        const movieTimescale = source.readUInt32BE(mvhd.body + (source[mvhd.body] ? 20 : 12));
        const movieDuration = (t: Track) => Math.round(t.durations.reduce((a, b) => a + b, 0) * movieTimescale / t.timescale);
        const large = payload > 0xffffffff - 64 * 1024 * 1024;

        const buildTrak = (t: Track, base: number) => rebuild(source, t.ref, {
            tkhd: ref => withDuration(source, ref, movieDuration(t), 28, 36),
            mdia: mdia => rebuild(source, mdia, {
                mdhd: ref => withDuration(source, ref, t.durations.reduce((a, b) => a + b, 0), 24, 32),
                minf: minf => rebuild(source, minf, {
                    stbl: stbl => {
                        const stsd = child(source, stbl, "stsd");
                        const stts = runLength(t.durations);
                        const ctts = runLength(t.compositionOffsets);
                        const stsc: number[] = [];
                        t.chunks.forEach((chunk, i) => {
                            if (!i || chunk.count !== t.chunks[i - 1].count) stsc.push(i + 1, chunk.count, 1);
                        });

                        return box("stbl",
                            source.subarray(stsd.start, stsd.end),
                            table("stts", stts, stts.length / 2),
                            ...(t.compositionOffsets.some(Boolean) ? [table("ctts", ctts, ctts.length / 2, [], 1)] : []),
                            ...(t.syncSamples.length < t.sizes.length ? [table("stss", t.syncSamples, t.syncSamples.length)] : []),
                            table("stsc", stsc, stsc.length / 3),
                            table("stsz", t.sizes, t.sizes.length, [0]),
                            chunkOffsets(t.chunks.map(c => base + c.target), large)
                        );
                    }
                })
            })
        });

        const buildMoov = (base: number) => box("moov", ...children(source, 8, source.length)
            .filter(c => c.type !== "mvex")
            .map(c => {
                if (c.type === "mvhd") return withDuration(source, c, Math.max(...[...tracks.values()].map(movieDuration)), 24, 32);
                const track = [...tracks.values()].find(t => t.ref.start === c.start);
                return track ? buildTrak(track, base) : source.subarray(c.start, c.end);
            }));

        const ftyp = box("ftyp", Buffer.from("isom\0\0\x02\0isomiso2avc1mp41", "latin1"));
        const mdatHeader = Buffer.alloc(large ? 16 : 8);
        mdatHeader.write("mdat", 4, "latin1");
        if (large) {
            mdatHeader.writeUInt32BE(1);
            mdatHeader.writeBigUInt64BE(BigInt(payload + 16), 8);
        } else {
            mdatHeader.writeUInt32BE(payload + 8);
        }

        const output = await open(tmp, "w");
        try {
            await output.write(Buffer.concat([ftyp, buildMoov(ftyp.length + buildMoov(0).length + mdatHeader.length), mdatHeader]));
            let buffer = Buffer.alloc(0);
            for (const chunk of chunks) {
                if (buffer.length < chunk.size) buffer = Buffer.alloc(chunk.size);
                await input.read(buffer, 0, chunk.size, chunk.offset);
                await output.write(buffer, 0, chunk.size);
            }
        } finally {
            await output.close();
        }
    } catch (err) {
        await rm(tmp, { force: true });
        throw err;
    } finally {
        await input.close();
    }

    await rename(tmp, path);
}

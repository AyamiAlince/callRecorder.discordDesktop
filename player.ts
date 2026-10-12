/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import { getSourceBufferType, SegmentIndex } from "./segments";

const logger = new Logger("CallRecorder");

const READ_SIZE = 2 * 1024 * 1024;
/** seconds buffered ahead of the playhead */
const AHEAD = 15;
/** seconds kept behind the playhead, so short rewinds don't reload */
const BEHIND = 30;

export interface PreviewSource {
    mimeType: string;
    index: SegmentIndex;
    /** seconds since the recording started */
    elapsed(): number;
    /** bytes that have reached the disk */
    written(): number;
    read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer> | null>;
}

/**
 * Plays the recording while it's still being written. Only a window around the playhead is kept in memory,
 * seeking elsewhere reloads from the nearest segment in the file.
 */
export class Player {
    error: string | null = null;

    private readonly media = new MediaSource();
    private readonly url = URL.createObjectURL(this.media);
    private readonly timer = setInterval(() => this.feed(), 250);
    private buffer: SourceBuffer | null = null;
    /** next byte of the recording to append */
    private offset = 0;
    /** a seek that still has to load its data */
    private seekTo: number | null;
    /** a position to move to once the video can take it */
    private target: number | null = null;
    /** bumped on every seek so reads started before it get dropped */
    private generation = 0;
    private busy = false;

    constructor(private readonly video: HTMLVideoElement, private readonly source: PreviewSource, start: number) {
        this.seekTo = start;
        video.src = this.url;
    }

    dispose() {
        clearInterval(this.timer);
        this.video.removeAttribute("src");
        this.video.load();
        URL.revokeObjectURL(this.url);
    }

    get position() {
        return this.seekTo ?? this.target ?? this.video.currentTime;
    }

    seek(time: number) {
        time = Math.max(0, Math.min(time, this.source.elapsed()));
        this.generation++;
        if (this.findRange(time) && this.video.readyState >= HTMLMediaElement.HAVE_METADATA) {
            this.seekTo = this.target = null;
            this.video.currentTime = time;
        } else {
            this.seekTo = time;
        }
    }

    private findRange(time: number) {
        const ranges = this.buffer?.buffered;
        if (!ranges) return null;
        for (let i = 0; i < ranges.length; i++) {
            if (ranges.start(i) <= time + 0.1 && time < ranges.end(i)) return { start: ranges.start(i), end: ranges.end(i) };
        }
        return null;
    }

    private update(buffer: SourceBuffer, action: () => void) {
        return new Promise<void>((resolve, reject) => {
            const controller = new AbortController();
            buffer.addEventListener("updateend", () => {
                controller.abort();
                resolve();
            }, { signal: controller.signal });
            buffer.addEventListener("error", () => {
                controller.abort();
                reject(new Error("The preview couldn't decode the recording"));
            }, { signal: controller.signal });

            try {
                action();
            } catch (err) {
                controller.abort();
                reject(err);
            }
        });
    }

    private async feed() {
        if (this.busy || this.error || this.media.readyState !== "open") return;

        this.busy = true;
        try {
            await this.step();
        } catch (err) {
            logger.error("Preview failed", err);
            this.error = String((err as Error)?.message ?? err);
        } finally {
            this.busy = false;
        }
    }

    private async step() {
        const { video, source } = this;

        if (!this.buffer) {
            // The recording hasn't written its first segment yet
            const { init } = source.index;
            if (!init) return;

            const type = getSourceBufferType(source.mimeType, init);
            if (!MediaSource.isTypeSupported(type)) throw new Error(`This Discord version can't play ${type} back.`);

            const buffer = this.media.addSourceBuffer(type);
            await this.update(buffer, () => buffer.appendBuffer(init));
            this.media.duration = Infinity;
            this.buffer = buffer;
        }
        const { buffer } = this;

        // With an endless duration only buffered data is seekable, this opens up the whole recording
        this.media.setLiveSeekableRange(0, Math.max(source.elapsed(), 0.1));

        if (this.seekTo != null) {
            const time = this.seekTo;
            if (!this.findRange(time)) {
                const segment = source.index.find(time);
                if (!segment) return;

                // Start over from the segment that has the target in it
                buffer.abort();
                if (buffer.buffered.length) await this.update(buffer, () => buffer.remove(0, Infinity));
                this.offset = segment.offset;
            }
            this.seekTo = null;
            this.target = time;
        }

        // The video ignores seeks until it has seen the init segment
        if (this.target != null && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
            const { target } = this;
            // Land on the first frame if the target is right before where the loaded data starts
            const next = Array.from({ length: buffer.buffered.length }, (_, i) => buffer.buffered.start(i)).find(start => start > target);
            video.currentTime = !this.findRange(target) && next != null && next - target < 3 ? next : target;
            this.target = null;
        }

        const time = this.target ?? video.currentTime;
        const { buffered } = buffer;
        if (buffered.length && time - buffered.start(0) > BEHIND * 2) {
            await this.update(buffer, () => buffer.remove(0, time - BEHIND));
            return;
        }

        const written = source.written();
        const end = buffered.length ? buffered.end(buffered.length - 1) : 0;
        if (end - time > AHEAD || this.offset >= written) return;

        const { generation } = this;
        const data = await source.read(this.offset, Math.min(READ_SIZE, written - this.offset));
        if (!data?.length || generation !== this.generation) return;

        try {
            await this.update(buffer, () => buffer.appendBuffer(data));
            this.offset += data.length;
        } catch (err) {
            if ((err as Error)?.name !== "QuotaExceededError") throw err;
            // Out of room, drop what's behind and try again on the next tick
            if (time - 5 > buffered.start(0)) await this.update(buffer, () => buffer.remove(0, time - 5));
        }
    }
}

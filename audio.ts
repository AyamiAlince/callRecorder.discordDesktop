/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { MediaEngineStore } from "@webpack/common";

import { Native } from ".";

const logger = new Logger("CallRecorder");
const POLL_INTERVAL = 50;
const LATENCY = 0.15;
const RETRY_DELAY = 10_000;

const loopback: MediaTrackConstraints & { mandatory: { chromeMediaSource: string; }; } = { mandatory: { chromeMediaSource: "desktop" } };

/** Discord's output device, or "" when it follows the Windows default */
function getOutputDeviceName() {
    const device = MediaEngineStore.getOutputDevices()[MediaEngineStore.getOutputDeviceId()];
    return !device || device.index === -1 || device.id === "default" ? "" : device.name;
}

function play(audio: AudioContext, destination: AudioNode, data: Uint8Array, next: number) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // packets are [int32 sample rate][int32 frames][frames * 2 float32], merge runs with the same rate
    for (let pos = 0; pos + 8 <= data.length;) {
        const rate = view.getInt32(pos, true);
        let frames = 0;
        let end = pos;
        while (end + 8 <= data.length && view.getInt32(end, true) === rate) {
            const packetFrames = view.getInt32(end + 4, true);
            frames += packetFrames;
            end += 8 + packetFrames * 8;
        }

        const buffer = audio.createBuffer(2, frames, rate);
        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);
        for (let frame = 0; pos < end;) {
            const packetFrames = view.getInt32(pos + 4, true);
            pos += 8;
            for (let i = 0; i < packetFrames; i++, frame++, pos += 8) {
                left[frame] = view.getFloat32(pos, true);
                right[frame] = view.getFloat32(pos + 4, true);
            }
        }

        const now = audio.currentTime;
        // Fell behind after silence (nothing gets captured while nothing plays), so start a fresh run
        if (next < now) next = now + LATENCY;
        // The device clock runs slightly faster than ours, drop a bit rather than drift away
        if (next > now + 1) continue;

        const source = audio.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        source.start(next);
        next += buffer.duration;
    }

    return next;
}

/**
 * Captures what Discord plays into `destination`. Chromium's desktop loopback only hears the default Windows
 * output device, so it misses Discord when Discord plays to another device (say headphones while Windows uses
 * speakers). On Windows a helper captures Discord's actual output device instead, and Chromium's loopback only
 * fills in until the helper is running or when it fails.
 */
export async function captureDesktopAudio(audio: AudioContext, destination: AudioNode) {
    const desktop = await navigator.mediaDevices.getUserMedia({ audio: loopback, video: loopback });
    desktop.getVideoTracks().forEach(t => t.stop());

    const fallback = audio.createGain();
    audio.createMediaStreamSource(desktop).connect(fallback).connect(destination);

    if (!navigator.platform.startsWith("Win")) return () => desktop.getTracks().forEach(t => t.stop());

    let stopped = false;
    let busy = false;
    let id: string | null = null;
    let device = "";
    let retryAt = 0;
    let next = 0;
    let live = false;

    const setLive = (value: boolean) => {
        if (live === value) return;
        live = value;
        fallback.gain.setTargetAtTime(live ? 0 : 1, audio.currentTime, 0.02);
    };

    const poll = async () => {
        if (busy) return;
        busy = true;
        try {
            const wanted = getOutputDeviceName();
            if (id && wanted !== device) {
                Native.stopLoopback(id);
                id = null;
                retryAt = 0;
                setLive(false);
            }

            if (!id) {
                if (Date.now() < retryAt) return;
                device = wanted;
                id = await Native.startLoopback(device);
                if (stopped && id) Native.stopLoopback(id);
                if (!id) {
                    logger.warn("Couldn't capture Discord's output device, recording the default device instead");
                    retryAt = Date.now() + RETRY_DELAY;
                }
                return;
            }

            const data = await Native.readLoopback(id);
            if (stopped) return;
            if (!data) {
                logger.warn("Output device capture stopped, recording the default device instead");
                id = null;
                retryAt = Date.now() + RETRY_DELAY;
                setLive(false);
            } else if (data.length) {
                if (next === 0) logger.info(`Capturing Discord's output device${device ? ` "${device}"` : ""}`);
                next = play(audio, destination, data, next);
                setLive(true);
            }
        } catch (err) {
            logger.error("Output device capture failed", err);
        } finally {
            busy = false;
        }
    };

    poll();
    const timer = setInterval(poll, POLL_INTERVAL);

    return () => {
        stopped = true;
        clearInterval(timer);
        if (id) Native.stopLoopback(id);
        desktop.getTracks().forEach(t => t.stop());
    };
}

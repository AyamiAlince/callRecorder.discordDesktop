/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { Stream } from "@vencord/discord-types";
import { ParticipantType } from "@vencord/discord-types/enums";
import { findByCodeLazy } from "@webpack";
import { ChannelRTCStore, ChannelStore, GuildStore, MediaEngineStore, moment, showToast, Toasts, UserStore } from "@webpack/common";

import { Native, settings } from ".";
import { captureDesktopAudio } from "./audio";
import { drawFrame, HEIGHT, Tile, WIDTH } from "./draw";
import type { PreviewSource } from "./player";
import { SegmentIndex } from "./segments";

const acquireVideo: (streamId: string) => { stream: MediaStream; release(): void; } = findByCodeLazy(".addDirectVideoOutputSink(");
const watchStream: (stream: Stream, options: { noFocus: boolean; forceMultiple: boolean; }) => void = findByCodeLazy('type:"STREAM_WATCH"');

const logger = new Logger("CallRecorder");
const FPS = 15;
const MIC_DELAY = 0.15;

const FORMATS = [
    { extension: "mp4", mimeType: "video/mp4;codecs=avc1,mp4a.40.2" },
    { extension: "mp4", mimeType: "video/mp4;codecs=avc1,opus" },
    { extension: "webm", mimeType: "video/webm;codecs=vp8,opus" }
] as const;

export interface Recording {
    stop(): void;
    /** null until the recording has actually started */
    preview: PreviewSource | null;
}

export function record(channelId: string, onFail: () => void): Recording {
    const cleanup: (() => unknown)[] = [];
    let recorder: MediaRecorder | undefined;
    let stopped = false;
    const recording: Recording = { stop: () => stop(), preview: null };

    const stop = () => {
        stopped = true;
        if (recorder?.state === "recording") recorder.stop();
    };

    const start = async () => {
        const channel = ChannelStore.getChannel(channelId);
        const guild = GuildStore.getGuild(channel.guild_id);
        const channelName = channel.name || channel.recipients.map(id => UserStore.getUser(id)?.username).join(", ");
        const title = guild ? `${guild.name}  ›  ${channelName}` : channelName;
        const myId = UserStore.getCurrentUser().id;

        const audio = new AudioContext();
        cleanup.push(() => audio.close());
        // Without a user gesture the context can start suspended, which would record silence
        audio.resume().catch(() => { });
        const output = audio.createMediaStreamDestination();
        cleanup.push(await captureDesktopAudio(audio, output));

        let micGain: GainNode | undefined;
        if (settings.store.recordMicrophone) {
            const deviceName = MediaEngineStore.getInputDevices()[MediaEngineStore.getInputDeviceId()]?.name;
            const deviceId = (await navigator.mediaDevices.enumerateDevices()).find(d => d.kind === "audioinput" && d.label === deviceName)?.deviceId;
            const mic = await navigator.mediaDevices.getUserMedia({
                audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), noiseSuppression: true }
            });
            cleanup.push(() => mic.getTracks().forEach(t => t.stop()));
            micGain = audio.createGain();
            micGain.gain.value = 0;
            // Discord's speaking state lags behind the voice, delay the mic so the gate opens before the first word
            const micDelay = audio.createDelay(1);
            micDelay.delayTime.value = MIC_DELAY;
            audio.createMediaStreamSource(mic).connect(micDelay).connect(micGain).connect(output);
        }

        const canvas = document.createElement("canvas");
        canvas.width = WIDTH;
        canvas.height = HEIGHT;
        const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
        const avatars = new Map<string, HTMLImageElement>();
        const videos = new Map<string, { video: HTMLVideoElement; release(): void; }>();
        const watched = new Set<string>();
        cleanup.push(() => videos.forEach(({ video, release }) => {
            video.srcObject = null;
            release();
        }));

        const tick = () => {
            const { recordCameras, recordStreams, autoWatchStreams } = settings.store;
            const usedVideos = new Set<string>();
            const liveStreams = new Set<string>();
            const tiles: Tile[] = [];
            let selfSpeaking = false;

            const getVideo = (streamId: string) => {
                usedVideos.add(streamId);
                let entry = videos.get(streamId);
                if (!entry) {
                    const { stream, release } = acquireVideo(streamId);
                    const video = document.createElement("video");
                    video.muted = true;
                    video.srcObject = stream;
                    video.play().catch(err => logger.warn("Failed to play video", err));
                    videos.set(streamId, entry = { video, release });
                }
                return entry.video;
            };

            for (const p of ChannelRTCStore.getParticipants(channelId)) {
                if (p.type === ParticipantType.USER && !p.ringing) {
                    const state = p.voiceState;
                    if (p.user.id === myId) selfSpeaking = p.speaking;
                    tiles.push({
                        user: p.user,
                        name: p.userNick || p.user.username,
                        video: recordCameras && p.streamId && !p.localVideoDisabled ? getVideo(p.streamId) : null,
                        screen: false,
                        speaking: p.speaking,
                        status: state?.deaf || state?.selfDeaf ? "Deafened" : state?.mute || state?.selfMute ? "Muted" : null
                    });
                } else if (p.type === ParticipantType.STREAM && recordStreams) {
                    liveStreams.add(p.id);
                    if (p.streamId) {
                        tiles.push({ user: p.user, name: `${p.userNick || p.user.username}'s screen`, video: getVideo(p.streamId), screen: true, speaking: false, status: null });
                    } else if (autoWatchStreams && p.user.id !== myId && !watched.has(p.id)) {
                        watched.add(p.id);
                        watchStream(p.stream, { noFocus: true, forceMultiple: true });
                    }
                }
            }

            watched.forEach(key => {
                if (!liveStreams.has(key)) watched.delete(key);
            });
            videos.forEach(({ video, release }, streamId) => {
                if (usedVideos.has(streamId)) return;
                video.srcObject = null;
                release();
                videos.delete(streamId);
            });

            drawFrame(ctx, title, tiles, avatars);

            // The raw mic hears everything, so only let it through while Discord transmits (voice activity or push to talk)
            const micLive = selfSpeaking && !MediaEngineStore.isSelfMute() && !MediaEngineStore.isSelfDeaf();
            micGain?.gain.setTargetAtTime(micLive ? 1 : 0, audio.currentTime + MIC_DELAY, micLive ? 0.01 : 0.05);
        };
        tick();
        const timer = setInterval(tick, 1000 / FPS);
        cleanup.push(() => clearInterval(timer));

        const format = settings.store.saveAsMp4 ? "mp4" : "webm";
        const { extension, mimeType } = FORMATS.find(f => f.extension === format && MediaRecorder.isTypeSupported(f.mimeType)) ?? FORMATS[FORMATS.length - 1];
        if (extension !== format) showToast("This Discord version can't record MP4, saving as WebM instead.", Toasts.Type.MESSAGE);

        const id = await Native.startFile(guild?.name ?? "Direct Messages", `${channelName} ${moment().format("YYYY-MM-DD HH-mm-ss")}`, extension);
        if (!id) throw new Error("Could not create the recording file");
        cleanup.push(() => Native.finishFile(id));

        if (stopped) {
            cleanup.forEach(fn => fn());
            return;
        }

        const options: MediaRecorderOptions & { videoKeyFrameIntervalDuration: number; } = {
            mimeType,
            videoBitsPerSecond: 3_000_000,
            videoKeyFrameIntervalDuration: 2000
        };
        const rec = recorder = new MediaRecorder(new MediaStream([...canvas.captureStream(FPS).getTracks(), ...output.stream.getTracks()]), options);

        const index = new SegmentIndex(extension === "webm");
        let startedAt = 0;
        let written = 0;
        rec.onstart = () => startedAt = performance.now();
        const elapsed = () => startedAt && (performance.now() - startedAt) / 1000;

        let writes = Promise.resolve();
        rec.ondataavailable = ({ data }) => {
            const time = elapsed();
            writes = writes.then(async () => {
                const chunk = new Uint8Array(await data.arrayBuffer());
                if (await Native.writeChunk(id, chunk)) {
                    index.push(chunk, time);
                    written += chunk.length;
                    return;
                }
                if (stopped) return;
                showToast("Call recording stopped because the file couldn't be written.", Toasts.Type.FAILURE);
                onFail();
            });
        };
        rec.onerror = e => {
            logger.error("Recorder error", e);
            showToast("Call recording stopped because of an encoder error.", Toasts.Type.FAILURE);
            onFail();
        };
        rec.onstop = () => writes.then(() => cleanup.forEach(fn => fn()));
        // Short chunks so the preview gets close to live
        rec.start(1000);

        recording.preview = {
            mimeType,
            index,
            elapsed,
            written: () => written,
            // IPC always hands over a fresh ArrayBuffer
            read: (offset, length) => Native.readChunk(id, offset, length) as Promise<Uint8Array<ArrayBuffer> | null>
        };
    };

    start().catch(err => {
        logger.error("Failed to start recording", err);
        showToast("Couldn't start the call recording.", Toasts.Type.FAILURE);
        cleanup.forEach(fn => fn());
        onFail();
    });

    return recording;
}

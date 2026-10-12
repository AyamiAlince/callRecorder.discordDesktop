/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { RenderModalProps } from "@vencord/discord-types";
import { closeModal, Modal, openModal, useEffect, useReducer, useRef, useState } from "@webpack/common";

import { Player, PreviewSource } from "./player";

const cl = classNameFactory("vc-call-recorder-");

/** where the newest data is, as it reaches the disk a few seconds late */
const LIVE_DELAY = 3;
const START_BEHIND = 30;

function formatTime(seconds: number) {
    const s = Math.max(0, Math.floor(seconds));
    const pad = (n: number) => String(n).padStart(2, "0");
    return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

function PreviewModal({ modalProps, source }: { modalProps: RenderModalProps; source: PreviewSource; }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [player, setPlayer] = useState<Player | null>(null);
    const [, rerender] = useReducer((n: number) => n + 1, 0);

    useEffect(() => {
        const instance = new Player(videoRef.current!, source, Math.max(0, source.elapsed() - START_BEHIND));
        setPlayer(instance);
        const timer = setInterval(rerender, 250);
        return () => {
            clearInterval(timer);
            instance.dispose();
        };
    }, []);

    const video = videoRef.current;
    const total = source.elapsed();
    const position = Math.min(player?.position ?? 0, total);
    const live = total - position < LIVE_DELAY + 3;
    const togglePlay = () => video && (video.paused ? video.play().catch(() => { }) : video.pause());

    return (
        <Modal
            {...modalProps}
            size="xl"
            title="Recording Preview"
            subtitle="The recording keeps going while you look back. Preview audio plays through your speakers, so it can end up in the recording too."
        >
            <div className={cl("preview")}>
                <video ref={videoRef} className={cl("preview-video")} autoPlay onClick={togglePlay} />
                {player?.error && <Paragraph className={cl("preview-error")}>{player.error}</Paragraph>}
                <input
                    type="range"
                    className={cl("preview-seek")}
                    min={0}
                    max={Math.max(total, 1)}
                    step={0.1}
                    value={position}
                    onChange={e => player?.seek(Number(e.currentTarget.value))}
                />
                <div className={cl("preview-controls")}>
                    <Button size="small" variant="secondary" onClick={() => player?.seek(position - 30)}>-30s</Button>
                    <Button size="small" variant="secondary" onClick={() => player?.seek(position - 10)}>-10s</Button>
                    <Button size="small" onClick={togglePlay}>{!video || video.paused ? "Play" : "Pause"}</Button>
                    <Button size="small" variant="secondary" onClick={() => player?.seek(position + 10)}>+10s</Button>
                    <Button size="small" variant="secondary" onClick={() => video && (video.muted = !video.muted)}>{video?.muted ? "Unmute" : "Mute"}</Button>
                    <span className={cl("preview-time")}>{formatTime(position)} / {formatTime(total)}</span>
                    <Button size="small" variant={live ? "dangerPrimary" : "secondary"} onClick={() => player?.seek(total - LIVE_DELAY)}>Live</Button>
                </div>
            </div>
        </Modal>
    );
}

export function openPreview(source: PreviewSource, onClose: () => void) {
    const key = openModal(props => <PreviewModal modalProps={props} source={source} />, { onCloseCallback: onClose });
    return () => closeModal(key);
}

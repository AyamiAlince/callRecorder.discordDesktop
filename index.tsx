/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { UserAreaButton, UserAreaRenderProps } from "@api/UserArea";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { Paragraph } from "@components/Paragraph";
import { EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { useFixedTimer } from "@utils/react";
import { formatDuration } from "@utils/text";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { proxyLazyWebpack } from "@webpack";
import { Flux, FluxDispatcher, RTCConnectionStore, SelectedChannelStore, useStateFromStores } from "@webpack/common";
import type { ReactNode } from "react";

import { record } from "./recorder";

export const Native = VencordNative.pluginHelpers.CallRecorder as PluginNative<typeof import("./native")>;

const cl = classNameFactory("vc-call-recorder-");
const FOLDER_KEYS: "folder"[] = ["folder"];

const RecorderStore = proxyLazyWebpack(() => {
    class RecorderStore extends Flux.Store {
        startedAt: number | null = null;
    }

    return new RecorderStore(FluxDispatcher);
});

let voiceChannelId: string | null = null;
let stopRecording: (() => void) | null = null;

function FolderSetting() {
    const { folder } = settings.use(FOLDER_KEYS);

    return (
        <Flex flexDirection="column" gap="8px">
            <Paragraph>Recordings are saved to {folder || "Documents/Discord Recordings"}, in a separate folder for each server.</Paragraph>
            <Flex gap="8px">
                <Button
                    onClick={async () => {
                        const dir = await Native.chooseFolder();
                        if (dir) settings.store.folder = dir;
                    }}
                >
                    Change Folder
                </Button>
                <Button variant="secondary" onClick={() => Native.openFolder()}>Open Folder</Button>
            </Flex>
        </Flex>
    );
}

export const settings = definePluginSettings({
    folder: {
        type: OptionType.COMPONENT,
        default: "",
        component: FolderSetting
    },
    saveAsMp4: {
        type: OptionType.BOOLEAN,
        displayName: "Save as MP4",
        description: "Save recordings as MP4 (H.264 and AAC), which plays and seeks properly almost anywhere without converting. When off, recordings are saved as WebM.",
        default: true
    },
    autoStart: {
        type: OptionType.BOOLEAN,
        description: "Start recording as soon as you join a voice channel. When off, use the record button in your user panel.",
        default: true
    },
    recordMicrophone: {
        type: OptionType.BOOLEAN,
        description: "Include your own microphone in recordings. It stays silent while you are muted.",
        default: true
    },
    recordCameras: {
        type: OptionType.BOOLEAN,
        description: "Show webcams in the recording when someone turns theirs on.",
        default: true
    },
    recordStreams: {
        type: OptionType.BOOLEAN,
        description: "Show screen shares you are watching in the recording.",
        default: true
    },
    autoWatchStreams: {
        type: OptionType.BOOLEAN,
        description: "Automatically watch new screen shares while recording so they get captured. Others will see you as a viewer.",
        default: true
    }
}, {
    autoWatchStreams: {
        disabled() { return !this.store.recordStreams; }
    }
});

function setRecording(channelId: string | null) {
    stopRecording?.();
    stopRecording = null;

    if (channelId) {
        const stop = record(channelId, () => {
            if (stopRecording === stop) setRecording(null);
        });
        stopRecording = stop;
    }

    RecorderStore.startedAt = channelId ? Date.now() : null;
    RecorderStore.emitChange();
}

function onSelectedChannelChange() {
    const channelId = SelectedChannelStore.getVoiceChannelId() ?? null;
    if (channelId === voiceChannelId) return;

    voiceChannelId = channelId;
    setRecording(channelId && settings.store.autoStart ? channelId : null);
}

function RecordIcon({ className, recording }: { className?: string; recording?: boolean; }) {
    return (
        <svg className={className} width="20" height="20" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="12" cy="12" r="5" fill={recording ? "var(--status-danger)" : "currentColor"} />
        </svg>
    );
}

function RecordButton({ iconForeground, hideTooltips, nameplate }: UserAreaRenderProps) {
    const inVoice = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId() != null);
    const recording = useStateFromStores([RecorderStore], () => RecorderStore.startedAt != null);
    if (!inVoice) return null;

    return (
        <UserAreaButton
            tooltipText={hideTooltips ? undefined : recording ? "Stop Recording" : "Start Recording"}
            icon={<RecordIcon className={iconForeground} recording={recording} />}
            role="switch"
            aria-checked={recording}
            redGlow={recording}
            plated={nameplate != null}
            onClick={() => setRecording(stopRecording ? null : voiceChannelId)}
        />
    );
}

function RecordingTimer({ startedAt }: { startedAt: number; }) {
    const elapsed = useFixedTimer({ initialTime: startedAt });

    return (
        <span className={cl("status")}>
            <span className={cl("dot")} />
            REC {formatDuration(elapsed)}
        </span>
    );
}

const StatusText = ErrorBoundary.wrap(({ text }: { text: ReactNode; }) => {
    const startedAt = useStateFromStores([RecorderStore], () => RecorderStore.startedAt);
    const connected = useStateFromStores([RTCConnectionStore], () => RTCConnectionStore.isConnected());

    return startedAt != null && connected ? <RecordingTimer startedAt={startedAt} /> : <>{text}</>;
}, { noop: true });

export default definePlugin({
    name: "CallRecorder",
    description: "Records voice calls as a video showing who is speaking, along with webcams and screen shares, saved in a separate folder for each server.",
    tags: ["Voice", "Media"],
    authors: [EquicordDevs.AyamiAlince],
    dependencies: ["UserAreaAPI"],
    settings,

    patches: [
        {
            find: "hasConnectedChannel:",
            replacement: {
                match: /(?<=text:)\i(?=,textVariant:\i,hasVideo:\i)/,
                replace: "$self.renderStatusText($&)"
            }
        }
    ],

    userAreaButton: {
        icon: RecordIcon,
        render: RecordButton
    },

    renderStatusText: (text: ReactNode) => <StatusText text={text} />,

    start() {
        SelectedChannelStore.addChangeListener(onSelectedChannelChange);
        onSelectedChannelChange();
    },

    stop() {
        SelectedChannelStore.removeChangeListener(onSelectedChannelChange);
        voiceChannelId = null;
        setRecording(null);
    }
});

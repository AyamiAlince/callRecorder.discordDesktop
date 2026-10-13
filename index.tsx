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
import { classNameFactory } from "@utils/css";
import { useFixedTimer } from "@utils/react";
import { formatDuration } from "@utils/text";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { proxyLazyWebpack } from "@webpack";
import { Flux, FluxDispatcher, RTCConnectionStore, SelectedChannelStore, showToast, Toasts, useStateFromStores } from "@webpack/common";
import type { ReactNode } from "react";

import { openPreview } from "./preview";
import { record, Recording } from "./recorder";

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
let activeRecording: Recording | null = null;
let closePreview: (() => void) | null = null;

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
        description: "Include your own microphone in recordings, only while Discord shows you as speaking so background noise stays out.",
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
    closePreview?.();
    closePreview = null;
    activeRecording?.stop();
    activeRecording = null;

    if (channelId) {
        const current = activeRecording = record(channelId, () => {
            if (activeRecording === current) setRecording(null);
        });
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

function PreviewIcon({ className }: { className?: string; }) {
    return (
        <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 2.64-6.36L3 8.3" />
            <path d="M3 3v5.3h5.3" />
            <path d="M12 7v5l3 2" />
        </svg>
    );
}

function RecordButton({ iconForeground, hideTooltips, nameplate }: UserAreaRenderProps) {
    const inVoice = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId() != null);
    const recording = useStateFromStores([RecorderStore], () => RecorderStore.startedAt != null);
    if (!inVoice) return null;

    return <>
        {recording && (
            <UserAreaButton
                tooltipText={hideTooltips ? undefined : "Recording Preview"}
                icon={<PreviewIcon className={iconForeground} />}
                plated={nameplate != null}
                onClick={showPreview}
            />
        )}
        <UserAreaButton
            tooltipText={hideTooltips ? undefined : recording ? "Stop Recording" : "Start Recording"}
            icon={<RecordIcon className={iconForeground} recording={recording} />}
            role="switch"
            aria-checked={recording}
            redGlow={recording}
            plated={nameplate != null}
            onClick={() => setRecording(activeRecording ? null : voiceChannelId)}
        />
    </>;
}

function showPreview() {
    if (closePreview) return;
    const source = activeRecording?.preview;
    if (!source) {
        showToast("The recording is still starting, try again in a moment.", Toasts.Type.MESSAGE);
        return;
    }

    const close = openPreview(source, () => {
        if (closePreview === close) closePreview = null;
    });
    closePreview = close;
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
    authors: [{
        name: "AyamiAlince",
        id: 863738240753074196n
    }],
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

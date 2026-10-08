/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";
import { ensureSafePath } from "@main/utils/ensureSafePath";
import { randomUUID } from "crypto";
import { app, dialog, type IpcMainInvokeEvent, shell } from "electron";
import { type FileHandle, mkdir, open, rm } from "fs/promises";
import { join } from "path";

import { defragment } from "./mp4";

const files = new Map<string, { handle: FileHandle; path: string; }>();
const EXTENSIONS = new Set(["mp4", "webm"]);
let backgroundThrottling = true;

const getBaseDir = () => RendererSettings.store.plugins?.CallRecorder?.folder || join(app.getPath("documents"), "Discord Recordings");

const sanitize = (name: string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 100) || "Unknown";

export async function chooseFolder(_: IpcMainInvokeEvent) {
    const { filePaths } = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"], defaultPath: getBaseDir() });
    return filePaths[0] ?? null;
}

export async function openFolder(_: IpcMainInvokeEvent) {
    const dir = getBaseDir();
    await mkdir(dir, { recursive: true });
    await shell.openPath(dir);
}

export async function startFile(e: IpcMainInvokeEvent, folder: string, name: string, extension: string) {
    if (typeof folder !== "string" || typeof name !== "string" || !EXTENSIONS.has(extension)) return null;

    const dir = ensureSafePath(getBaseDir(), sanitize(folder));
    if (!dir) return null;

    try {
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${sanitize(name)}.${extension}`);
        const handle = await open(path, "wx");
        const id = randomUUID();

        if (!files.size) backgroundThrottling = e.sender.getBackgroundThrottling();
        files.set(id, { handle, path });
        e.sender.setBackgroundThrottling(false);
        return id;
    } catch {
        return null;
    }
}

export async function writeChunk(_: IpcMainInvokeEvent, id: string, data: Uint8Array) {
    const file = files.get(id);
    if (!file || !(data instanceof Uint8Array)) return false;

    try {
        await file.handle.write(data);
        return true;
    } catch {
        return false;
    }
}

export async function finishFile(e: IpcMainInvokeEvent, id: string) {
    const file = files.get(id);
    if (!file) return;

    files.delete(id);
    if (!files.size) e.sender.setBackgroundThrottling(backgroundThrottling);

    try {
        const { size } = await file.handle.stat();
        await file.handle.close();
        if (!size) await rm(file.path);
        else if (file.path.endsWith(".mp4")) await defragment(file.path);
    } catch (err) {
        console.error("CallRecorder: failed to finish recording", err);
    }
}

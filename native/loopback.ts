/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type ChildProcess, spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { app, type IpcMainInvokeEvent } from "electron";
import source from "file://loopback.cs";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

// Drop audio nobody picked up instead of growing forever if the renderer stops reading
const MAX_BUFFERED = 8 * 1024 * 1024;

const SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "if (-not (Test-Path $env:VC_LOOPBACK_DLL)) {",
    "    $tmp = \"$env:VC_LOOPBACK_DLL.$PID.dll\"",
    "    Add-Type -Path $env:VC_LOOPBACK_CS -OutputAssembly $tmp",
    "    Move-Item $tmp $env:VC_LOOPBACK_DLL -Force",
    "}",
    "Add-Type -Path $env:VC_LOOPBACK_DLL",
    "[CallRecorderLoopback]::Run($env:VC_LOOPBACK_DEVICE, [int]$env:VC_LOOPBACK_PARENT)"
].join("; ");

interface Capture {
    proc: ChildProcess;
    /** stdout that doesn't make up a whole packet yet */
    pending: Buffer;
    packets: Buffer[];
    size: number;
    alive: boolean;
}

const captures = new Map<string, Capture>();

async function prepare() {
    const dir = join(app.getPath("temp"), "vc-call-recorder");
    const hash = createHash("sha1").update(source).digest("hex").slice(0, 12);
    const cs = join(dir, `loopback-${hash}.cs`);
    const dll = join(dir, `loopback-${hash}.dll`);
    if (!existsSync(dll)) {
        await mkdir(dir, { recursive: true });
        await writeFile(cs, source);
    }
    return { cs, dll };
}

export async function startLoopback(_: IpcMainInvokeEvent, device: string) {
    if (process.platform !== "win32" || typeof device !== "string") return null;

    try {
        const { cs, dll } = await prepare();
        const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT], {
            env: { ...process.env, VC_LOOPBACK_CS: cs, VC_LOOPBACK_DLL: dll, VC_LOOPBACK_DEVICE: device, VC_LOOPBACK_PARENT: String(process.pid) },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true
        });

        const id = randomUUID();
        const capture: Capture = { proc, pending: Buffer.alloc(0), packets: [], size: 0, alive: true };
        proc.stdout!.on("data", (data: Buffer) => {
            let buf = capture.pending.length ? Buffer.concat([capture.pending, data]) : data;
            // packet: [int32 sample rate][int32 frames][frames * 2 float32]
            while (buf.length >= 8 && buf.length >= 8 + buf.readInt32LE(4) * 8) {
                const size = 8 + buf.readInt32LE(4) * 8;
                capture.packets.push(buf.subarray(0, size));
                capture.size += size;
                buf = buf.subarray(size);
            }
            capture.pending = buf;
            while (capture.size > MAX_BUFFERED) capture.size -= capture.packets.shift()!.length;
        });
        proc.stderr!.on("data", (data: Buffer) => console.log("CallRecorder loopback:", data.toString("utf8").trim()));
        proc.on("error", err => {
            console.error("CallRecorder: failed to start loopback capture", err);
            capture.alive = false;
        });
        proc.on("exit", () => capture.alive = false);

        captures.set(id, capture);
        return id;
    } catch (err) {
        console.error("CallRecorder: failed to start loopback capture", err);
        return null;
    }
}

/** Returns the whole packets captured since the last call, or null once the capture has died. */
export function readLoopback(_: IpcMainInvokeEvent, id: string) {
    const capture = captures.get(id);
    if (!capture || !capture.alive && !capture.size) return null;

    const data = Buffer.concat(capture.packets);
    capture.packets = [];
    capture.size = 0;
    return new Uint8Array(data);
}

export function stopLoopback(_: IpcMainInvokeEvent, id: string) {
    const capture = captures.get(id);
    if (!capture) return;

    captures.delete(id);
    capture.proc.kill();
}

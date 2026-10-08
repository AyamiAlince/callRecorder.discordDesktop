/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { User } from "@vencord/discord-types";
import { IconUtils } from "@webpack/common";

export interface Tile {
    user: User;
    name: string;
    video: HTMLVideoElement | null;
    screen: boolean;
    speaking: boolean;
    status: string | null;
}

export const WIDTH = 1920;
export const HEIGHT = 1080;
const HEADER = 96;
const SIDEBAR = 420;
const GAP = 16;
const FONT = "\"gg sans\", \"Noto Sans\", sans-serif";

function getAvatar(user: User, avatars: Map<string, HTMLImageElement>) {
    const url = IconUtils.getUserAvatarURL(user, false, 256);
    let avatar = avatars.get(url);
    if (!avatar) {
        avatar = new Image();
        avatar.crossOrigin = "anonymous";
        avatar.src = url;
        avatars.set(url, avatar);
    }
    return avatar;
}

function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, maxWidth: number) {
    const width = Math.min(ctx.measureText(text).width, maxWidth);
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.beginPath();
    ctx.roundRect(x, y, width + size, size * 1.6, size * 0.4);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(text, x + size / 2, y + size * 0.8, width);
}

function drawTile(ctx: CanvasRenderingContext2D, tile: Tile, x: number, y: number, w: number, h: number, avatars: Map<string, HTMLImageElement>) {
    const { video } = tile;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 12);
    ctx.fillStyle = "#2b2d31";
    ctx.fill();
    ctx.clip();

    if (video?.videoWidth) {
        const scale = (tile.screen ? Math.min : Math.max)(w / video.videoWidth, h / video.videoHeight);
        const videoWidth = video.videoWidth * scale;
        const videoHeight = video.videoHeight * scale;
        ctx.drawImage(video, x + (w - videoWidth) / 2, y + (h - videoHeight) / 2, videoWidth, videoHeight);
    } else {
        const avatar = getAvatar(tile.user, avatars);
        const radius = Math.min(w, h) * 0.25;
        ctx.beginPath();
        ctx.arc(x + w / 2, y + h / 2, radius, 0, Math.PI * 2);
        ctx.fillStyle = "#4e5058";
        ctx.fill();
        ctx.clip();
        if (avatar.complete && avatar.naturalWidth) ctx.drawImage(avatar, x + w / 2 - radius, y + h / 2 - radius, radius * 2, radius * 2);
    }
    ctx.restore();

    if (tile.speaking) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 12);
        ctx.lineWidth = 4;
        ctx.strokeStyle = "#23a55a";
        ctx.stroke();
    }

    const size = Math.round(Math.min(28, Math.max(14, h / 12)));
    const padding = size / 2;
    ctx.font = `600 ${size}px ${FONT}`;
    drawLabel(ctx, tile.name, x + padding, y + h - padding - size * 1.6, size, "#ffffff", w - padding * 2 - size);
    if (tile.status) drawLabel(ctx, tile.status, x + padding, y + padding, size, "#f23f43", w - padding * 2 - size);
}

function drawGrid(ctx: CanvasRenderingContext2D, tiles: Tile[], x: number, y: number, width: number, height: number, avatars: Map<string, HTMLImageElement>) {
    const scale = (cols: number) => Math.min(width / cols / 16, height / Math.ceil(tiles.length / cols) / 9);
    let cols = 1;
    for (let i = 2; i <= tiles.length; i++) {
        if (scale(i) > scale(cols)) cols = i;
    }

    const tileWidth = width / cols;
    const tileHeight = height / Math.ceil(tiles.length / cols);
    tiles.forEach((tile, i) => {
        const row = Math.floor(i / cols);
        const offset = (cols - Math.min(cols, tiles.length - row * cols)) * tileWidth / 2;
        drawTile(ctx, tile, x + offset + (i % cols) * tileWidth + GAP / 2, y + row * tileHeight + GAP / 2, tileWidth - GAP, tileHeight - GAP, avatars);
    });
}

export function drawFrame(ctx: CanvasRenderingContext2D, title: string, tiles: Tile[], avatars: Map<string, HTMLImageElement>) {
    ctx.fillStyle = "#1e1f22";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.textBaseline = "middle";
    ctx.font = `600 36px ${FONT}`;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "right";
    ctx.fillText(new Date().toLocaleString(), WIDTH - GAP * 2, HEADER / 2);
    ctx.textAlign = "left";
    ctx.fillText(title, GAP * 2, HEADER / 2, WIDTH - 600);

    const screens = tiles.filter(t => t.screen);
    const users = tiles.filter(t => !t.screen);
    const top = HEADER - GAP / 2;
    const height = HEIGHT - top - GAP / 2;

    if (screens.length) {
        drawGrid(ctx, screens, GAP / 2, top, WIDTH - SIDEBAR - GAP, height, avatars);
        drawGrid(ctx, users, WIDTH - SIDEBAR - GAP / 2, top, SIDEBAR, height, avatars);
    } else {
        drawGrid(ctx, users, GAP / 2, top, WIDTH - GAP, height, avatars);
    }
}

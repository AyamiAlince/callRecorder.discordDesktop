/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Captures what a specific output device plays (WASAPI loopback) and writes it to stdout as
// packets of [int32 sample rate][int32 frame count][frame count * 2 float32 stereo samples].
// Chromium's desktop loopback only ever hears the default Windows device, which misses
// Discord's audio when Discord plays to a different one.

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class CallRecorderLoopback
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        int GetCount(out int count);
        int Item(int index, out IMMDevice device);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int access, out IPropertyStore properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    }

    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        int GetCount(out int count);
        int GetAt(int index, out PropertyKey key);
        int GetValue(ref PropertyKey key, out PropVariant value);
    }

    [Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        int GetBufferSize(out uint frames);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out uint padding);
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        int GetMixFormat(out IntPtr format);
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr handle);
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        int ReleaseBuffer(uint frames);
        int GetNextPacketSize(out uint frames);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey
    {
        public Guid FormatId;
        public int PropertyId;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct PropVariant
    {
        [FieldOffset(0)] public short Type;
        [FieldOffset(8)] public IntPtr Pointer;
        [FieldOffset(16)] public long Padding;
    }

    [DllImport("ole32.dll")]
    static extern int PropVariantClear(ref PropVariant value);

    const int RENDER = 0, CONSOLE = 0, DEVICE_STATE_ACTIVE = 1, CLSCTX_ALL = 23, STGM_READ = 0;
    const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x20000;
    const uint AUDCLNT_BUFFERFLAGS_SILENT = 2;
    const short VT_LPWSTR = 31;

    static PropertyKey FriendlyName = new PropertyKey { FormatId = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), PropertyId = 14 };

    static void Check(int hr)
    {
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    }

    static string GetName(IMMDevice device)
    {
        IPropertyStore store;
        Check(device.OpenPropertyStore(STGM_READ, out store));
        PropVariant value;
        Check(store.GetValue(ref FriendlyName, out value));
        try
        {
            return value.Type == VT_LPWSTR ? Marshal.PtrToStringUni(value.Pointer) : "";
        }
        finally
        {
            PropVariantClear(ref value);
            Marshal.ReleaseComObject(store);
        }
    }

    // An empty name means the default output device, otherwise the device with that name,
    // falling back to the default device when no such device is connected.
    static IMMDevice FindDevice(IMMDeviceEnumerator enumerator, string name, out string id)
    {
        IMMDevice found = null;
        if (name.Length > 0)
        {
            IMMDeviceCollection devices;
            Check(enumerator.EnumAudioEndpoints(RENDER, DEVICE_STATE_ACTIVE, out devices));
            int count;
            Check(devices.GetCount(out count));
            IMMDevice partial = null;
            for (int i = 0; i < count && found == null; i++)
            {
                IMMDevice device;
                Check(devices.Item(i, out device));
                string deviceName = GetName(device);
                if (string.Equals(deviceName, name, StringComparison.OrdinalIgnoreCase)) found = device;
                else if (partial == null && (deviceName.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf(deviceName, StringComparison.OrdinalIgnoreCase) >= 0)) partial = device;
            }
            Marshal.ReleaseComObject(devices);
            if (found == null) found = partial;
        }
        if (found == null) Check(enumerator.GetDefaultAudioEndpoint(RENDER, CONSOLE, out found));
        Check(found.GetId(out id));
        return found;
    }

    static bool ParentAlive(int pid)
    {
        try
        {
            return !Process.GetProcessById(pid).HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    public static void Run(string name, int parentPid)
    {
        name = (name ?? "").Trim();
        var output = Console.OpenStandardOutput();
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();

        while (ParentAlive(parentPid))
        {
            try
            {
                string id;
                var device = FindDevice(enumerator, name, out id);
                Console.Error.WriteLine("Capturing " + GetName(device));
                Capture(enumerator, device, id, name, parentPid, output);
            }
            catch (IOException)
            {
                // stdout was closed, so nobody is listening anymore
                return;
            }
            catch (Exception e)
            {
                Console.Error.WriteLine(e.Message);
            }
            Thread.Sleep(1000);
        }
    }

    static void Capture(IMMDeviceEnumerator enumerator, IMMDevice device, string id, string name, int parentPid, Stream output)
    {
        var iid = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        object obj;
        Check(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out obj));
        Marshal.ReleaseComObject(device);
        var client = (IAudioClient)obj;

        IntPtr format;
        Check(client.GetMixFormat(out format));
        int tag = Marshal.ReadInt16(format, 0) & 0xFFFF;
        int channels = Marshal.ReadInt16(format, 2);
        int rate = Marshal.ReadInt32(format, 4);
        int bits = Marshal.ReadInt16(format, 14);
        bool isFloat = tag == 3 || (tag == 0xFFFE && Marshal.ReadInt32(format, 24) == 3);
        try
        {
            if (isFloat ? bits != 32 : bits != 16 && bits != 32) throw new NotSupportedException("Unsupported mix format: " + bits + " bit");
            Check(client.Initialize(0, AUDCLNT_STREAMFLAGS_LOOPBACK, 2000000, 0, format, IntPtr.Zero));
        }
        finally
        {
            Marshal.FreeCoTaskMem(format);
        }

        iid = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
        Check(client.GetService(ref iid, out obj));
        var capture = (IAudioCaptureClient)obj;
        Check(client.Start());

        var buffer = new byte[0];
        int lastCheck = Environment.TickCount;
        try
        {
            while (true)
            {
                Thread.Sleep(10);

                uint frames;
                Check(capture.GetNextPacketSize(out frames));
                while (frames > 0)
                {
                    IntPtr data;
                    uint flags;
                    ulong devicePosition, qpcPosition;
                    Check(capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition));

                    int size = 8 + (int)frames * 8;
                    if (buffer.Length < size) buffer = new byte[size];
                    BitConverter.GetBytes(rate).CopyTo(buffer, 0);
                    BitConverter.GetBytes((int)frames).CopyTo(buffer, 4);
                    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) Array.Clear(buffer, 8, size - 8);
                    else Downmix(data, (int)frames, channels, bits, isFloat, buffer);

                    Check(capture.ReleaseBuffer(frames));
                    output.Write(buffer, 0, size);
                    output.Flush();
                    Check(capture.GetNextPacketSize(out frames));
                }

                if (Environment.TickCount - lastCheck > 1000)
                {
                    lastCheck = Environment.TickCount;
                    if (!ParentAlive(parentPid)) return;

                    // Reopen when the device we want becomes a different one (default device changed, headphones plugged in)
                    string newId;
                    Marshal.ReleaseComObject(FindDevice(enumerator, name, out newId));
                    if (newId != id) return;
                }
            }
        }
        finally
        {
            client.Stop();
            Marshal.ReleaseComObject(capture);
            Marshal.ReleaseComObject(client);
        }
    }

    static float[] samples = new float[0], stereo = new float[0];

    static void Downmix(IntPtr data, int frames, int channels, int bits, bool isFloat, byte[] buffer)
    {
        int count = frames * channels;
        if (samples.Length < count) samples = new float[count];
        if (stereo.Length < frames * 2) stereo = new float[frames * 2];

        if (isFloat) Marshal.Copy(data, samples, 0, count);
        else if (bits == 16)
        {
            var raw = new short[count];
            Marshal.Copy(data, raw, 0, count);
            for (int i = 0; i < count; i++) samples[i] = raw[i] / 32768f;
        }
        else
        {
            var raw = new int[count];
            Marshal.Copy(data, raw, 0, count);
            for (int i = 0; i < count; i++) samples[i] = raw[i] / 2147483648f;
        }

        for (int i = 0; i < frames; i++)
        {
            int frame = i * channels;
            float left = samples[frame];
            float right = channels > 1 ? samples[frame + 1] : left;
            if (channels > 2)
            {
                // fold the center channel in, which is where surround setups put voices
                float center = samples[frame + 2] * 0.7071f;
                left += center;
                right += center;
            }
            stereo[i * 2] = left;
            stereo[i * 2 + 1] = right;
        }
        Buffer.BlockCopy(stereo, 0, buffer, 8, frames * 8);
    }
}

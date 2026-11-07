"""Runs an iOS 27+ iPhone directly through Apple's developer services, with no control app.

Run with the app's pymobiledevice3 helper Python (the developer image must be mounted):
    python direct.py pair <udid>          (over the cable, once: lets the phone connect over Wi-Fi)
    python direct.py <udid> <stream port> <control port> [wifi]

The stream port is pymobiledevice3's screen server: the phone's screen as HEVC video
(/codec, /stream.bin) and touch and buttons (/touch, /button). The control port adds what
that server lacks, as JSON over HTTP on 127.0.0.1:
    GET  /info        { width, height, scale }, the screen in points
    POST /screenshot  { png } in base64
    POST /launch      { bundleId }
    POST /terminate   { bundleId }
    POST /type        { text }
    POST /shortcut    { usages }, HID key codes held together
Both ports share one tunnel to the phone, which lasts as long as this process.
"""
import asyncio
import base64
import json
import sys

from pymobiledevice3.exceptions import RemotePairingCompletedError
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.remote import tunnel_service, userspace_tunnel
from pymobiledevice3.remote.core_device.app_service import AppServiceService
from pymobiledevice3.remote.core_device.device_info import DeviceInfoService
from pymobiledevice3.remote.core_device.hid_service import ASCII_TO_HID, KEY_LEFT_SHIFT
from pymobiledevice3.remote.core_device.screen_capture_service import ScreenCaptureService
from pymobiledevice3.remote.core_device.screen_stream import ScreenStreamServer
from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel

KEY_HOLD = 0.04
KEY_GAP = 0.02
MAX_BODY = 1024 * 1024


async def screen_info(rsd):
    async with DeviceInfoService(rsd) as service:
        info = await service.get_display_info()
    mode = info["displays"][0]["currentMode"]
    scale = mode.get("preferredUIScale") or 3
    width, height = mode["size"]
    return {"width": round(width / scale), "height": round(height / scale), "scale": scale}


async def screenshot(rsd):
    async with ScreenCaptureService(rsd) as service:
        shot = await service.capture_screenshot()
    return {"png": base64.b64encode(shot["image"]).decode()}


async def launch(rsd, bundle_id):
    async with AppServiceService(rsd) as service:
        await service.launch_application(bundle_id, kill_existing=False)
    return {"ok": True}


async def terminate(rsd, bundle_id):
    async with AppServiceService(rsd) as service:
        apps = await service.list_apps()
        app = next((a for a in apps if a.get("bundleIdentifier") == bundle_id), None)
        if not app:
            raise ValueError(f"{bundle_id} isn't installed")
        prefix = f"file://{app['path'].removeprefix('/private')}"
        for process in await service.list_processes():
            url = (process.get("executableURL") or {}).get("relative", "").replace("/private/", "/", 1)
            if url.startswith(prefix):
                await service.send_signal_to_process(process["processIdentifier"], 9)
    return {"ok": True}


async def type_text(server, text):
    unsupported = sorted({ch for ch in text if ch not in ASCII_TO_HID})
    if unsupported:
        raise ValueError(f"Can't type {' '.join(unsupported)} on this phone yet: plain keyboard characters only")
    await server._ensure_keyboard()
    keyboard = server._kb_service_id
    for ch in text:
        usage, shift = ASCII_TO_HID[ch]
        if shift:
            # iOS can miss Shift if it arrives together with the key.
            await server._uhs.send_keyboard(keyboard, (KEY_LEFT_SHIFT,))
            await asyncio.sleep(KEY_HOLD)
        await server._uhs.send_keyboard(keyboard, (KEY_LEFT_SHIFT, usage) if shift else (usage,))
        await asyncio.sleep(KEY_HOLD)
        await server._uhs.send_keyboard(keyboard, ())
        await asyncio.sleep(KEY_GAP)
    return {"ok": True}


async def shortcut(server, usages):
    await server._ensure_keyboard()
    # Press one at a time: like Shift, iOS can miss a modifier that arrives with the key.
    for count in range(1, len(usages) + 1):
        await server._uhs.send_keyboard(server._kb_service_id, tuple(usages[:count]))
        await asyncio.sleep(KEY_HOLD)
    await server._uhs.send_keyboard(server._kb_service_id, ())
    return {"ok": True}


async def route(rsd, server, method, path, body):
    if method == "GET" and path == "/info":
        return await screen_info(rsd)
    if method == "POST" and path == "/screenshot":
        return await screenshot(rsd)
    if method == "POST" and path == "/launch":
        return await launch(rsd, body["bundleId"])
    if method == "POST" and path == "/terminate":
        return await terminate(rsd, body["bundleId"])
    if method == "POST" and path == "/type":
        return await type_text(server, body["text"])
    if method == "POST" and path == "/shortcut":
        return await shortcut(server, body["usages"])
    raise LookupError(path)


def control_handler(rsd, server):
    async def handle(reader, writer):
        status = "200 OK"
        try:
            head = (await reader.readuntil(b"\r\n\r\n")).decode("latin-1").split("\r\n")
            method, path = head[0].split(" ")[:2]
            headers = dict(line.lower().split(": ", 1) for line in head[1:] if ": " in line)
            length = min(int(headers.get("content-length", 0)), MAX_BODY)
            raw = await reader.readexactly(length) if length else b"{}"
            result = await route(rsd, server, method, path, json.loads(raw))
        except LookupError:
            status, result = "404 Not Found", {"error": "not found"}
        except Exception as e:
            status, result = "500 Internal Server Error", {"error": str(e) or type(e).__name__}
        payload = json.dumps(result).encode()
        writer.write(
            f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n".encode()
        )
        writer.write(payload)
        await writer.drain()
        writer.close()

    return handle


async def pair(udid):
    """Makes the record Wi-Fi connections need. The phone already trusts this PC, so it doesn't ask."""
    lockdown = await create_using_usbmux(serial=udid)
    service = await tunnel_service.RemotePairingLockdownService.create(lockdown)
    try:
        await service.connect(autopair=True)
    except RemotePairingCompletedError:
        pass  # that's how the phone says it's done: it saved the pairing and hung up
    await service.close()
    await lockdown.close()


async def wifi_provider(serial, autopair, remotepairing_fallback=True):
    """Tunnels over the network: iOS 27 hangs up on the usual route unless it's on the cable."""
    services = await tunnel_service.get_remote_pairing_tunnel_services(udid=serial)
    if not services:
        raise ConnectionError("The phone isn't advertising on this network")
    return services[0], None


async def main(udid, stream_port, control_port, transport="usb"):
    if transport == "wifi":
        userspace_tunnel._create_no_root_tunnel_provider = wifi_provider
    async with UserspaceRsdTunnel(serial=udid) as rsd:
        server = ScreenStreamServer(rsd, http_port=stream_port, audio_default_on=False)
        control = await asyncio.start_server(control_handler(rsd, server), "127.0.0.1", control_port)
        async with control:
            await server.serve()


if __name__ == "__main__":
    if sys.argv[1] == "pair":
        asyncio.run(pair(sys.argv[2]))
    else:
        asyncio.run(main(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), *sys.argv[4:5]))

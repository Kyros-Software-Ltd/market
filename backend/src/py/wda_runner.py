"""Start WebDriverAgent over a pymobiledevice3 userspace RSD tunnel and proxy 8100+9100.

Same end state as go-ios runwda + forward — used when go-ios Wi-Fi tunnel fails
(typical on iOS 27). Wi-Fi uses RemotePairing (Bonjour or MARKET_PHONE_IP:49152),
not CoreDeviceProxy-over-usbmux (iOS 27 hangs that up).

    python wda_runner.py <udid> <localWdaPort> <localMjpegPort> <bundleId> [usb|wifi] [deviceWdaPort deviceMjpegPort]

Prints: {"ready":true,"wdaPort":N,"mjpegPort":M}
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from contextlib import suppress

from pymobiledevice3 import usbmux
from pymobiledevice3.exceptions import ConnectionFailedError, RemotePairingCompletedError
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.remote import tunnel_service, userspace_tunnel
from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel
from pymobiledevice3.services.dvt.testmanaged.xcuitest import TestConfig, XCUITestService

WDA_DEVICE_PORT = 8100
MJPEG_DEVICE_PORT = 9100


async def pair(udid: str) -> None:
    lockdown = await create_using_usbmux(serial=udid)
    service = await tunnel_service.RemotePairingLockdownService.create(lockdown)
    try:
        await service.connect(autopair=True)
    except RemotePairingCompletedError:
        pass
    await service.close()
    await lockdown.close()


async def wifi_provider(serial, autopair, remotepairing_fallback=True):
    """RemotePairing only — CoreDeviceProxy over Wi-Fi usbmux dies on iOS 27."""
    from pymobiledevice3.remote.tunnel_service import create_core_device_tunnel_service_using_remotepairing

    try:
        services = await tunnel_service.get_remote_pairing_tunnel_services(udid=serial)
        if services:
            return services[0], None
    except Exception as e:
        print(f"bonjour remotepairing failed: {e}", flush=True)

    ip = (os.environ.get("MARKET_PHONE_IP") or "").strip()
    if not ip:
        raise ConnectionError(
            "Wi-Fi RemotePairing not found. Unlock the phone on the same Wi-Fi, "
            "or plug in once so Market can pair."
        )
    port = int(os.environ.get("MARKET_PHONE_PAIR_PORT") or "49152")
    print(f"remotepairing via known IP {ip}:{port}", flush=True)
    service = await create_core_device_tunnel_service_using_remotepairing(
        serial, ip, port, autopair=False
    )
    return service, None


async def wait_usbmux_port(udid: str, port: int, timeout: float = 90.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError(f"WDA did not listen on device port {port}")
        device = await usbmux.select_device(udid)
        if device is None:
            await asyncio.sleep(0.3)
            continue
        try:
            sock = await device.connect(port)
        except ConnectionFailedError:
            await asyncio.sleep(0.25)
            continue
        else:
            sock.close()
            return


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, asyncio.CancelledError):
        pass
    finally:
        with suppress(Exception):
            writer.close()


async def proxy_client(udid: str, device_port: int, local_reader, local_writer) -> None:
    device = await usbmux.select_device(udid)
    if device is None:
        local_writer.close()
        return
    try:
        remote = await device.connect(device_port)
        remote.setblocking(False)
    except Exception:
        local_writer.close()
        return

    remote_reader, remote_writer = await asyncio.open_connection(sock=remote)
    t1 = asyncio.create_task(pipe(local_reader, remote_writer))
    t2 = asyncio.create_task(pipe(remote_reader, local_writer))
    done, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    with suppress(Exception):
        remote_writer.close()
    with suppress(Exception):
        local_writer.close()


async def serve_proxy(udid: str, local_port: int, device_port: int) -> asyncio.AbstractServer:
    async def handle(reader, writer):
        await proxy_client(udid, device_port, reader, writer)

    return await asyncio.start_server(handle, "127.0.0.1", local_port)


async def open_rsd(udid: str, transport: str, attempts: int = 4):
    from pymobiledevice3.exceptions import ConnectionTerminatedError

    last = None
    for i in range(attempts):
        try:
            tunnel = UserspaceRsdTunnel(serial=udid)
            return await tunnel.__aenter__()
        except (ConnectionTerminatedError, ConnectionError, OSError, TimeoutError) as e:
            last = e
            print(f"rsd tunnel attempt {i + 1}/{attempts} failed: {e}", flush=True)
            await asyncio.sleep(1.5 + i)
    raise last or ConnectionError("RSD tunnel failed")


async def main(
    udid: str,
    local_wda: int,
    local_mjpeg: int,
    bundle_id: str,
    transport: str = "usb",
    device_wda: int = WDA_DEVICE_PORT,
    device_mjpeg: int = MJPEG_DEVICE_PORT,
) -> None:
    if transport == "wifi":
        userspace_tunnel._create_no_root_tunnel_provider = wifi_provider

    attempts = 4 if transport == "wifi" else 1
    rsd = await open_rsd(udid, transport, attempts=attempts)
    try:
        cfg = await TestConfig.create_for(rsd, runner_bundle_id=bundle_id)
        # WDA reads its ports from the runner's environment; off the defaults, an app on the
        # phone that checks 8100/9100 finds nothing there.
        cfg.runner_app_env = {"USE_PORT": str(device_wda), "MJPEG_SERVER_PORT": str(device_mjpeg)}
        xct = XCUITestService(rsd)
        runner = asyncio.create_task(xct.run(cfg), name="wda-xctrunner")

        try:
            await asyncio.sleep(0.5)
            if runner.done():
                runner.result()

            await wait_usbmux_port(udid, device_wda)
            wda_server = await serve_proxy(udid, local_wda, device_wda)
            mjpeg_server = await serve_proxy(udid, local_mjpeg, device_mjpeg)
            print(
                json.dumps(
                    {
                        "ready": True,
                        "wdaPort": local_wda,
                        "mjpegPort": local_mjpeg,
                        "deviceWdaPort": device_wda,
                        "deviceMjpegPort": device_mjpeg,
                    }
                ),
                flush=True,
            )

            async with wda_server, mjpeg_server:
                await runner
        finally:
            if not runner.done():
                runner.cancel()
                with suppress(asyncio.CancelledError):
                    await runner
    finally:
        with suppress(Exception):
            await rsd.__aexit__(None, None, None)


if __name__ == "__main__":
    if sys.argv[1] == "pair":
        asyncio.run(pair(sys.argv[2]))
    else:
        udid, local_wda, local_mjpeg, bundle_id = (
            sys.argv[1],
            int(sys.argv[2]),
            int(sys.argv[3]),
            sys.argv[4],
        )
        transport = sys.argv[5] if len(sys.argv) > 5 else "usb"
        device_wda = int(sys.argv[6]) if len(sys.argv) > 6 else WDA_DEVICE_PORT
        device_mjpeg = int(sys.argv[7]) if len(sys.argv) > 7 else MJPEG_DEVICE_PORT
        asyncio.run(main(udid, local_wda, local_mjpeg, bundle_id, transport, device_wda, device_mjpeg))

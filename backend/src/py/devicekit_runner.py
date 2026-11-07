"""Start DeviceKit over a pymobiledevice3 userspace RSD tunnel and proxy it to localhost.

Used when go-ios cannot build a Wi-Fi tunnel (typical on iOS 27). The tunnel stays
in-process; XCUITest starts DeviceKit; a local TCP proxy reaches it via usbmux so
Market's Node DeviceKitClient can keep using http://127.0.0.1:<localPort>.

    python devicekit_runner.py <udid> <localPort> <bundleId> [wifi]

Prints one JSON line when ready: {"ready":true,"localPort":N,"devicePort":12004}
Stays alive until killed.
"""
from __future__ import annotations

import asyncio
import json
import sys
from contextlib import suppress

from pymobiledevice3 import usbmux
from pymobiledevice3.exceptions import ConnectionFailedError, RemotePairingCompletedError
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.remote import tunnel_service, userspace_tunnel
from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel
from pymobiledevice3.services.dvt.testmanaged.xcuitest import TestConfig, XCUITestService

DEVICE_PORT = 12004  # DeviceKit default HTTP / MJPEG port


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
    """Wi-Fi tunnel: prefer CoreDeviceProxy over usbmux (Market routes that to the phone's
    Wi-Fi IP). Bonjour RemotePairing is a fallback — on Windows it often finds nothing.
    """
    from pymobiledevice3.exceptions import InvalidServiceError
    from pymobiledevice3.remote.userspace_tunnel import UserspaceTunnelUnavailableError

    lockdown = await create_using_usbmux(serial=serial, autopair=autopair)
    try:
        return await tunnel_service.CoreDeviceTunnelProxy.create(lockdown), lockdown
    except InvalidServiceError:
        await lockdown.close()
    except BaseException:
        await lockdown.close()
        raise

    if not remotepairing_fallback:
        raise UserspaceTunnelUnavailableError(
            "No CoreDeviceProxy over Wi-Fi lockdown and RemotePairing fallback was disabled"
        )

    services = await tunnel_service.get_remote_pairing_tunnel_services(udid=serial)
    if not services:
        raise ConnectionError(
            "Wi-Fi tunnel failed: lockdown CoreDeviceProxy unavailable and no RemotePairing "
            "service on the network. Keep the phone unlocked on the same Wi-Fi, or plug in once."
        )
    return services[0], None


async def wait_usbmux_port(udid: str, port: int, timeout: float = 90.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError(f"DeviceKit did not listen on device port {port}")
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


async def main(udid: str, local_port: int, bundle_id: str, transport: str = "usb") -> None:
    if transport == "wifi":
        userspace_tunnel._create_no_root_tunnel_provider = wifi_provider

    async with UserspaceRsdTunnel(serial=udid) as rsd:
        cfg = await TestConfig.create_for(rsd, runner_bundle_id=bundle_id)
        xct = XCUITestService(rsd)
        runner = asyncio.create_task(xct.run(cfg), name="devicekit-xctrunner")

        try:
            # Fail fast if XCTest dies during startup.
            await asyncio.sleep(0.5)
            if runner.done():
                runner.result()

            await wait_usbmux_port(udid, DEVICE_PORT)
            server = await serve_proxy(udid, local_port, DEVICE_PORT)
            print(json.dumps({"ready": True, "localPort": local_port, "devicePort": DEVICE_PORT}), flush=True)

            async with server:
                # Stay up until the XCTest runner exits or we are killed.
                await runner
        finally:
            if not runner.done():
                runner.cancel()
                with suppress(asyncio.CancelledError):
                    await runner


if __name__ == "__main__":
    if sys.argv[1] == "pair":
        asyncio.run(pair(sys.argv[2]))
    else:
        udid, local_port, bundle_id = sys.argv[1], int(sys.argv[2]), sys.argv[3]
        transport = sys.argv[4] if len(sys.argv) > 4 else "usb"
        asyncio.run(main(udid, local_port, bundle_id, transport))

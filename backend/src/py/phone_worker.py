"""One process per iPhone: gets a plugged-in phone to a running WebDriverAgent, then keeps
the two local ports (control + live view) open until anything breaks.

    python phone_worker.py <udid> <localWdaPort> <localMjpegPort> <deviceWdaPort> <deviceMjpegPort>
    python phone_worker.py --standby      (loads everything, then reads the line above as JSON on stdin)

Environment:
    USBMUXD_SOCKET_ADDRESS  Apple's usbmux service
    MARKET_WDA_BUNDLE       the WebDriverAgent bundle id as shipped (before signing adds a team id)
    MARKET_IOS_VERSION      the phone's iOS version if Market already knows it

Every state change is one JSON line on stdout:
    {"state":"starting","step":"..."}
    {"state":"needs_action","kind":"trust|unlock|install|resign|devmode|trust-developer"}
    {"state":"ready","wdaPort":N,"mjpegPort":M,"bundleId":"...","iosVersion":"..."}
    {"state":"dead","error":"..."}
Anything else printed is a log line.

There is no recovery in here. Whatever goes wrong, the process says why and exits, and
phone.js starts a fresh one. The only branch is the iOS version: 17+ needs an RSD tunnel,
older versions talk to lockdown directly. Cable only: phones on the network are ignored.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import threading
import traceback
from contextlib import suppress

from pymobiledevice3 import usbmux
from pymobiledevice3.exceptions import (
    AlreadyMountedError,
    ConnectionFailedError,
    NotPairedError,
    NotTrustedError,
    PairingDialogResponsePendingError,
    PasswordRequiredError,
    UserDeniedPairingError,
)
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.remote import tunnel_service, userspace_tunnel
from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel
from pymobiledevice3.services.amfi import AmfiService
from pymobiledevice3.services.dvt.testmanaged.xcuitest import TestConfig, XCUITestService
from pymobiledevice3.services.installation_proxy import InstallationProxyService
from pymobiledevice3.services.mobile_image_mounter import auto_mount

USB = "USB"  # usbmux also lists phones it sees on the network; only the cable is used


class NeedsAction(Exception):
    """The person has to do something on the phone before this can continue."""

    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


def emit(**msg) -> None:
    print(json.dumps(msg), flush=True)


def step(text: str) -> None:
    emit(state="starting", step=text)


def log(text: str) -> None:
    print(text, flush=True)


def now() -> float:
    return asyncio.get_running_loop().time()


# What a failure text means the person has to do. Checked in order.
FAILURE_KINDS = [
    ("trust-developer", r"explicitly trusted|not trusted|untrusted|could not get pid|failed to launch app"),
    ("resign", r"invalid code signature|profile has expired|no longer valid|0xe8008018|0xe800801c"),
    ("install", r"did not find test app|is it installed|AppNotInstalled"),
    ("devmode", r"DeveloperModeIsNotEnabled|developer mode is not enabled"),
    ("unlock", r"PasswordRequired|device is locked|passcode"),
]


def classify(text: str) -> str | None:
    for kind, pattern in FAILURE_KINDS:
        if re.search(pattern, text, re.I):
            return kind
    return None


def describe(error) -> str:
    """An error as text, including the reasons iOS nests inside its own errors."""
    parts = [f"{type(error).__name__}: {error}"]

    def walk(ns, depth=0):
        if ns is None or depth > 4:
            return
        info = getattr(ns, "user_info", None) or {}
        parts.append(
            f"{getattr(ns, 'domain', '')} code {getattr(ns, 'code', '')}: "
            f"{info.get('NSLocalizedDescription', '')} {info.get('NSLocalizedFailureReason', '')}".strip()
        )
        walk(info.get("NSUnderlyingError"), depth + 1)

    walk(getattr(error, "error", None))
    return " | ".join(parts)


def ios_major(version: str) -> int:
    with suppress(ValueError):
        return int(str(version).split(".")[0])
    return 0


# ---------- steps ----------


async def open_lockdown(udid: str):
    """Also the trust check: lockdown only answers once the phone trusts this PC."""
    try:
        # pair_timeout keeps a pending "Trust This Computer?" dialog from blocking forever.
        return await create_using_usbmux(serial=udid, autopair=True, pair_timeout=2, connection_type=USB)
    except PasswordRequiredError:
        raise NeedsAction("unlock") from None
    except (NotPairedError, NotTrustedError, PairingDialogResponsePendingError, UserDeniedPairingError):
        raise NeedsAction("trust") from None


async def find_wda(lockdown, configured: str) -> str | None:
    """Signing with a free Apple ID adds a team id to the bundle id, so match loosely."""
    apps = await InstallationProxyService(lockdown).get_apps(application_type="User")
    ids = list(apps.keys())
    if configured in ids:
        return configured
    for test in (
        lambda i: "webdriveragentrunner" in i.lower() and "xctrunner" in i.lower(),
        lambda i: "webdriveragent" in i.lower(),
    ):
        for bundle_id in ids:
            if test(bundle_id):
                return bundle_id
    return None


async def check_developer_mode(lockdown) -> None:
    if await lockdown.get_developer_mode_status():
        return
    # iOS hides the Developer Mode switch in Settings until something asks for it.
    with suppress(Exception):
        await AmfiService(lockdown).reveal_developer_mode_option_in_ui()
    raise NeedsAction("devmode")


async def mount_image(provider) -> None:
    try:
        await asyncio.wait_for(auto_mount(provider), timeout=300)
    except AlreadyMountedError:
        pass


async def cable_only(lockdown) -> None:
    """Older versions of Market switched on the phone's "Wi-Fi connections". Switch it back off,
    so the phone stops offering itself over the network."""
    try:
        if await lockdown.get_enable_wifi_connections():
            await lockdown.set_enable_wifi_connections(False)
            log("switched the phone's Wi-Fi connections off (Market is cable only)")
    except Exception:
        pass  # never set on this phone: already off


async def usb_tunnel_provider(serial, autopair, remotepairing_fallback=True):
    """The iOS 17+ tunnel, always through the cable."""
    lockdown = await create_using_usbmux(serial=serial, autopair=False, connection_type=USB)
    try:
        return await tunnel_service.CoreDeviceTunnelProxy.create(lockdown), lockdown
    except BaseException:
        with suppress(Exception):
            await lockdown.close()
        raise


async def open_device(udid: str, port: int):
    """A stream to a port on the phone, through the cable: (reader, writer)."""
    device = await usbmux.select_device(udid, connection_type=USB)
    if device is None:
        raise ConnectionError("phone gone")
    sock = await device.connect(port)
    sock.setblocking(False)
    return await asyncio.open_connection(sock=sock)


async def wait_device_port(udid: str, port: int, runner: asyncio.Task, timeout: float = 90.0) -> None:
    deadline = now() + timeout
    while True:
        if runner.done():
            runner.result()  # raises what stopped WebDriverAgent
            raise RuntimeError("The control app quit while starting")
        if now() >= deadline:
            raise TimeoutError("The control app did not start. Keep the phone unlocked.")
        try:
            _, writer = await open_device(udid, port)
        except (ConnectionFailedError, ConnectionError, OSError):
            await asyncio.sleep(0.15)
        else:
            writer.close()
            return


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError, asyncio.CancelledError):
        pass
    finally:
        with suppress(Exception):
            writer.close()


async def serve_proxy(udid: str, local_port: int, device_port: int) -> asyncio.AbstractServer:
    async def handle(local_reader, local_writer):
        try:
            remote_reader, remote_writer = await open_device(udid, device_port)
        except Exception:
            with suppress(Exception):
                local_writer.close()
            return
        tasks = {
            asyncio.create_task(pipe(local_reader, remote_writer)),
            asyncio.create_task(pipe(remote_reader, local_writer)),
        }
        _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        for w in (remote_writer, local_writer):
            with suppress(Exception):
                w.close()

    return await asyncio.start_server(handle, "127.0.0.1", local_port)


# ---------- the one path ----------


async def check_phone(udid: str, major: int, configured: str, marks: dict):
    """Everything asked over lockdown. Returns (lockdown, bundle_id, mounted, version)."""
    lockdown = await asyncio.wait_for(open_lockdown(udid), timeout=25)
    marks["trust"] = now()
    try:
        if await lockdown.get_value(key="PasswordProtected") is True:
            raise NeedsAction("unlock")
        version = lockdown.product_version
        major = major or ios_major(version)

        async def app():
            found = await asyncio.wait_for(find_wda(lockdown, configured), timeout=30)
            if not found:
                raise NeedsAction("install")
            return found

        async def devmode():
            if major < 16:
                return
            try:
                await asyncio.wait_for(check_developer_mode(lockdown), timeout=20)
            except NeedsAction:
                raise
            except Exception as e:
                log(f"could not read Developer Mode ({type(e).__name__}: {e}); continuing")

        async def image():
            try:
                await mount_image(lockdown)
                return True
            except Exception as e:
                # Newer iOS only accepts this through the tunnel; it is tried again there.
                if major < 17:
                    log(f"developer image: {type(e).__name__}: {e}")
                return False

        # Each of these opens its own service on the phone, so they can run side by side.
        bundle_id, _, mounted = await asyncio.gather(app(), devmode(), image())
        await cable_only(lockdown)
        marks["checks"] = now()
        return lockdown, bundle_id, mounted, version
    except BaseException:
        with suppress(BaseException):
            await asyncio.wait_for(lockdown.close(), timeout=3)
        raise


async def run(udid: str, local_wda: int, local_mjpeg: int, device_wda: int, device_mjpeg: int) -> None:
    configured = os.environ.get("MARKET_WDA_BUNDLE") or "com.facebook.WebDriverAgentRunner.xctrunner"
    known_major = ios_major(os.environ.get("MARKET_IOS_VERSION", ""))
    start = now()
    marks: dict[str, float] = {}
    userspace_tunnel._create_no_root_tunnel_provider = usb_tunnel_provider

    async def open_tunnel():
        rsd = await asyncio.wait_for(UserspaceRsdTunnel(serial=udid).__aenter__(), timeout=60)
        marks["tunnel"] = now()
        return rsd

    step("Connecting to the phone")
    # The tunnel (iOS 17+) does not depend on the checks, so when the iOS version is already
    # known both start at once.
    tunnel = asyncio.create_task(open_tunnel()) if known_major >= 17 else None
    checks = asyncio.create_task(check_phone(udid, known_major, configured, marks))
    lockdown = rsd = None
    try:
        # The checks come first: if the phone is locked or untrusted, that is the answer the
        # person needs, not the tunnel error it also causes.
        lockdown, bundle_id, mounted, version = await checks
        major = ios_major(version)
        if not major:
            raise RuntimeError("Could not read the phone's iOS version")

        step("Starting the control app")
        if major >= 17:
            rsd = await (tunnel if tunnel is not None else open_tunnel())
            provider = rsd
            if not mounted:
                try:
                    await mount_image(rsd)
                except Exception as e:
                    log(f"developer image: {type(e).__name__}: {e}")
        else:
            provider = lockdown

        cfg = await TestConfig.create_for(provider, runner_bundle_id=bundle_id)
        cfg.runner_app_env = {"USE_PORT": str(device_wda), "MJPEG_SERVER_PORT": str(device_mjpeg)}
        marks["launch"] = now()
        runner = asyncio.create_task(XCUITestService(provider).run(cfg), name="wda")
        try:
            await wait_device_port(udid, device_wda, runner)
            wda_server = await serve_proxy(udid, local_wda, device_wda)
            mjpeg_server = await serve_proxy(udid, local_mjpeg, device_mjpeg)
            took = ", ".join(f"{k} {round(v - start, 1)}" for k, v in sorted(marks.items(), key=lambda kv: kv[1]))
            log(f"control app up after {round(now() - start, 1)}s ({took})")
            emit(state="ready", wdaPort=local_wda, mjpegPort=local_mjpeg, bundleId=bundle_id, iosVersion=version)
            async with wda_server, mjpeg_server:
                await runner
            raise RuntimeError("The control app stopped")
        finally:
            if not runner.done():
                runner.cancel()
                with suppress(BaseException):
                    await asyncio.wait_for(runner, timeout=3)
    finally:
        for task in (tunnel, checks):
            if task is not None and not task.done():
                task.cancel()
        if rsd is None and tunnel is not None and tunnel.done() and not tunnel.cancelled() and tunnel.exception() is None:
            rsd = tunnel.result()
        if rsd is not None:
            with suppress(BaseException):
                await asyncio.wait_for(rsd.__aexit__(None, None, None), timeout=3)
        if lockdown is not None:
            with suppress(BaseException):
                await asyncio.wait_for(lockdown.close(), timeout=3)


def exit_with_parent() -> None:
    """Market holds this process's stdin open; if Market dies, don't linger holding the ports."""

    def watch():
        with suppress(Exception):
            sys.stdin.buffer.read()
        os._exit(0)

    threading.Thread(target=watch, daemon=True).start()


def main() -> int:
    argv = sys.argv[1:]
    if argv[:1] == ["--standby"]:
        # Started ahead of time with everything loaded; Market sends the phone when it has one.
        line = sys.stdin.buffer.readline()
        if not line.strip():
            return 0
        job = json.loads(line)
        os.environ.update({k: str(v) for k, v in job.get("env", {}).items()})
        argv = job["argv"]
    exit_with_parent()
    udid = argv[0]
    ports = [int(a) for a in argv[1:5]]
    try:
        asyncio.run(run(udid, *ports))
    except NeedsAction as e:
        emit(state="needs_action", kind=e.kind)
        return 3
    except KeyboardInterrupt:
        return 0
    except BaseException as e:  # noqa: BLE001 - every failure is reported the same way
        text = describe(e)
        if os.environ.get("MARKET_DEBUG"):
            log("".join(traceback.format_exception(type(e), e, e.__traceback__)))
        where = traceback.extract_tb(e.__traceback__)[-1]
        log(f"stopped at {os.path.basename(where.filename)}:{where.lineno} — {text[-400:]}")
        kind = classify(text)
        if kind:
            emit(state="needs_action", kind=kind)
            return 3
        emit(state="dead", error=text[:300])
        return 1
    return 1


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    os._exit(code)  # tunnel threads can keep a normal exit hanging

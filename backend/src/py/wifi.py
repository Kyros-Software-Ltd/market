"""Turns an iPhone's Wi-Fi connections on or off (it must be plugged in over USB).

Run with the app's pymobiledevice3 helper Python:
    python wifi.py enable <udid>
    python wifi.py disable <udid>
    python wifi.py status <udid>
Prints one JSON object on stdout. Once on, the phone accepts the same trusted
connections over the local network that it does over USB, so Market can reach it
without the cable.
"""
import asyncio
import json
import sys

from pymobiledevice3.lockdown import create_using_usbmux


async def run(cmd, udid):
    lockdown = await create_using_usbmux(serial=udid)
    if cmd in ("enable", "disable"):
        await lockdown.set_enable_wifi_connections(cmd == "enable")
    try:
        enabled = await lockdown.get_enable_wifi_connections()
    except Exception:  # never set on this phone: off
        enabled = False
    return {"ok": True, "enabled": bool(enabled), "wifiMac": lockdown.wifi_mac_address}


def main():
    cmd, udid = sys.argv[1:3]
    try:
        result = asyncio.run(run(cmd, udid))
    except Exception as e:  # report every failure as JSON so the app can show it
        result = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()

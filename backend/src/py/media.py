"""Copies media from the PC into the control app's Documents folder on an iPhone.

Run with the app's pymobiledevice3 helper Python:
    python media.py push <udid> <bundle_id> <file> [<file> ...]
    python media.py remove <udid> <bundle_id> <name> [<name> ...]
    python media.py container <udid> <bundle_id>
Prints one JSON object on stdout. Files land in Documents/Market/, which the Files app
shows under On My iPhone once the control app has file sharing switched on.
"""
import asyncio
import json
import os
import posixpath
import sys

from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.house_arrest import HouseArrestService
from pymobiledevice3.services.installation_proxy import InstallationProxyService

FOLDER = "Market"


async def open_documents(lockdown, bundle_id):
    """Documents-only vending needs file sharing; developer-signed apps also allow the whole container.
    Either way paths stay relative to the container, so the folder is /Documents/Market."""
    try:
        return await HouseArrestService.create(lockdown, bundle_id, documents_only=True)
    except Exception:
        return await HouseArrestService.create(lockdown, bundle_id, documents_only=False)


async def push(udid, bundle_id, files):
    lockdown = await create_using_usbmux(serial=udid)
    afc = await open_documents(lockdown, bundle_id)
    async with afc:
        folder = posixpath.join("/Documents", FOLDER)
        await afc.makedirs(folder)
        sent = []
        for path in files:
            name = os.path.basename(path)
            await afc.push(path, posixpath.join(folder, name), progress_bar=False)
            sent.append(name)
        return {"ok": True, "sent": sent, "folder": folder}


async def remove(udid, bundle_id, names):
    lockdown = await create_using_usbmux(serial=udid)
    afc = await open_documents(lockdown, bundle_id)
    async with afc:
        removed = []
        for name in names:
            target = posixpath.join("/Documents", FOLDER, os.path.basename(name))
            try:
                await afc.rm(target)
                removed.append(name)
            except Exception:
                pass  # already gone
        return {"ok": True, "removed": removed}


async def container(udid, bundle_id):
    lockdown = await create_using_usbmux(serial=udid)
    proxy = InstallationProxyService(lockdown=lockdown)
    info = await proxy.lookup({"BundleIDs": [bundle_id], "ReturnAttributes": ["Container", "CFBundleDisplayName", "UIFileSharingEnabled"]})
    app = (info or {}).get(bundle_id) or {}
    return {"ok": True, "container": app.get("Container"), "name": app.get("CFBundleDisplayName"),
            "fileSharing": bool(app.get("UIFileSharingEnabled"))}


def main():
    cmd, udid, bundle_id, *rest = sys.argv[1:]
    try:
        commands = {"push": lambda: push(udid, bundle_id, rest), "remove": lambda: remove(udid, bundle_id, rest),
                    "container": lambda: container(udid, bundle_id)}
        result = asyncio.run(commands[cmd]())
    except Exception as e:  # report every failure as JSON so the app can show it
        result = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()

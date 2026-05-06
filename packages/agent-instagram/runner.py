#!/usr/bin/env python3
"""
Instagrapi runner — receives a JSON operation on stdin, returns JSON on stdout.

Usage:
  echo '{"op":"set_bio","username":"...","password":"...","bio":"..."}' | python3 runner.py

Supported ops:
  set_bio     — {"op":"set_bio","username":"...","password":"...","bio":"..."}
  set_name    — {"op":"set_name","username":"...","password":"...","name":"..."}
  set_website — {"op":"set_website","username":"...","password":"...","url":"..."}
  set_pic     — {"op":"set_pic","username":"...","password":"...","image_path":"..."}

Returns on stdout:
  {"ok": true}
  {"ok": false, "error": "..."}

Session is cached at ~/.agent-instagram/<username>/instagrapi-session.json
to avoid re-login on subsequent calls.
"""

import sys
import json
import os
import re
import subprocess
import traceback


def log(msg: str) -> None:
    """Write diagnostic message to stderr (not captured by caller)."""
    print(f"[instagrapi] {msg}", file=sys.stderr, flush=True)


def ensure_instagrapi() -> None:
    """Install instagrapi if not already installed."""
    try:
        import instagrapi  # noqa: F401
    except ImportError:
        log("instagrapi not found — installing...")
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "instagrapi>=2.0,<3.0",
             "--break-system-packages", "--quiet"],
            stderr=subprocess.DEVNULL,
        )
        log("instagrapi installed")


def get_session_path(username: str) -> str:
    """Return the path to the cached session file for username."""
    # Validate username against Instagram's allowed character set to prevent
    # path traversal (e.g. a username of "../../.ssh" would be malicious).
    if not re.match(r'^[a-zA-Z0-9_.]{1,30}$', username):
        raise ValueError(f"Invalid Instagram username: {username!r}")
    state_dir = os.path.expanduser(f"~/.agent-instagram/{username}")
    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    return os.path.join(state_dir, "instagrapi-session.json")


def try_restore_session(client, username: str) -> bool:
    """
    Attempt to restore a cached session.
    Returns True if session is valid, False otherwise.
    """
    session_path = get_session_path(username)
    if not os.path.exists(session_path):
        return False
    try:
        client.load_settings(session_path)
        # Validate session is still alive
        client.get_timeline_feed()
        log(f"Restored cached session for {username}")
        return True
    except Exception as e:
        log(f"Cached session invalid ({e}), will re-authenticate")
        return False


def save_session(client, username: str) -> None:
    """Persist session settings to disk with secure permissions."""
    session_path = get_session_path(username)
    client.dump_settings(session_path)
    os.chmod(session_path, 0o600)
    log(f"Session cached to {session_path}")


def patch_challenge_resolver(client) -> None:
    """
    Monkey-patch instagrapi's challenge resolver to handle the STEP_NAME bloks
    challenge that Instagram uses for new-device login verification.

    The STEP_NAME challenge (bloks_action = com.bloks.www.ig.challenge.redirect.async)
    is a "was this you?" prompt. We respond with choice=0 (yes, it was me) to
    dismiss it, which is the same strategy instagrapi uses for delta_login_review.
    """
    original_resolve_simple = client.challenge_resolve_simple

    def patched_resolve_simple(challenge_url: str) -> bool:
        step_name = client.last_json.get("step_name", "")
        bloks_action = client.last_json.get("bloks_action", "")

        if step_name == "STEP_NAME" and "bloks" in bloks_action:
            log(f"Handling bloks STEP_NAME challenge — sending choice=0 (it was me)")
            try:
                client._send_private_request(challenge_url[1:], {"choice": "0"})
                return True
            except Exception as e:
                log(f"Bloks challenge dismiss failed: {e}, falling back to original resolver")

        return original_resolve_simple(challenge_url)

    client.challenge_resolve_simple = patched_resolve_simple


def login(client, username: str, password: str) -> None:
    """Login with instagrapi, using cached session if available."""
    patch_challenge_resolver(client)
    if not try_restore_session(client, username):
        log(f"Authenticating as {username}...")
        client.login(username, password)
        save_session(client, username)
        log("Login successful")


def run_op(client, data: dict) -> dict:
    """Dispatch the requested operation and return result dict."""
    op = data.get("op")

    if op == "set_bio":
        bio = data.get("bio", "")
        client.account_edit(biography=bio)
        return {"ok": True}

    elif op == "set_name":
        name = data.get("name", "")
        client.account_edit(full_name=name)
        return {"ok": True}

    elif op == "set_website":
        url = data.get("url", "")
        # account_edit(external_url=...) silently discards the value on many
        # accounts. The correct endpoint is update_bio_links, exposed by
        # instagrapi as set_external_url(). However, set_external_url APPENDS
        # to the bio_links list rather than replacing — so we must remove
        # stale links after setting to leave exactly one entry.
        result = client.set_external_url(url)
        bio_links = result.get("user", {}).get("bio_links", [])
        stale_ids = [
            link["link_id"] for link in bio_links
            if link.get("url", "").rstrip("/") != url.rstrip("/")
        ]
        if stale_ids:
            client.remove_bio_links(stale_ids)
        return {"ok": True}

    elif op == "set_pic":
        image_path = data.get("image_path")
        if not image_path:
            return {"ok": False, "error": "Missing image_path"}
        if not os.path.isfile(image_path):
            return {"ok": False, "error": f"File not found: {image_path}"}
        from pathlib import Path
        import tempfile
        try:
            from PIL import Image
        except ImportError:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "Pillow>=10.0,<13.0",
                 "--break-system-packages", "--quiet"],
                stderr=subprocess.DEVNULL,
            )
            from PIL import Image
        # Normalise to JPEG so instagrapi/Pillow always gets a valid format
        img = Image.open(image_path)
        if img.mode != "RGB":
            img = img.convert("RGB")
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            img.save(tmp_path, "JPEG", quality=95)
            client.account_change_picture(Path(tmp_path))
        finally:
            os.unlink(tmp_path)
        return {"ok": True}

    elif op == "get_profile":
        # Use account_info() for the authenticated user's own profile.
        # account_info() hits /accounts/current_user/ which includes external_url.
        # When external_url is None (can happen when bio_links is the source of
        # truth), fall back to reading bio_links from the raw response.
        account = client.account_info()
        pic_url = ""
        if account.profile_pic_url:
            pic_url = str(account.profile_pic_url)

        # Prefer account.external_url; if absent, read the first bio_link URL.
        website = getattr(account, "external_url", None) or ""
        if not website:
            raw = client.private_request("accounts/current_user/", params={"edit": "true"})
            bio_links = raw.get("user", {}).get("bio_links", [])
            if bio_links:
                website = bio_links[0].get("url", "")

        return {
            "ok": True,
            "profile": {
                "username": account.username or "",
                "name": account.full_name or "",
                "biography": account.biography or "",
                "followersCount": getattr(account, "follower_count", 0) or 0,
                "followsCount": getattr(account, "following_count", 0) or 0,
                "mediaCount": getattr(account, "media_count", 0) or 0,
                "profilePictureUrl": pic_url,
                "website": website,
            },
        }

    else:
        return {"ok": False, "error": f"Unknown op: {op}"}


def main() -> None:
    # Validate Python version
    if sys.version_info < (3, 9):
        result = {"ok": False, "error": f"Python 3.9+ required, got {sys.version}"}
        print(json.dumps(result))
        sys.exit(1)

    ensure_instagrapi()

    from instagrapi import Client

    try:
        data = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    username = data.get("username")
    password = data.get("password")

    if not username or not password:
        print(json.dumps({"ok": False, "error": "Missing required fields: username, password"}))
        sys.exit(1)

    if not data.get("op"):
        print(json.dumps({"ok": False, "error": "Missing required field: op"}))
        sys.exit(1)

    client = Client()

    try:
        login(client, username, password)
        result = run_op(client, data)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        result = {"ok": False, "error": str(e)}

    print(json.dumps(result), flush=True)
    if not result.get("ok"):
        sys.exit(1)


if __name__ == "__main__":
    main()

"""
Backend Sanity Test Suite for The Void
=======================================
Tests the Rust engine REST API (port 8080) and the Python Director WebSocket (port 8000).

Usage:
    cd apps/python-director
    python test_backend.py

Prerequisites:
    - Rust engine running on port 8080
    - Python Director running on port 8000
    pip install httpx websockets (already in requirements.txt)
"""

import asyncio
import json
import sys
import httpx

RUST_BASE = "http://127.0.0.1:8080"
PYTHON_WS = "ws://127.0.0.1:8000/api/v1/dream-stream"

passed = 0
failed = 0

def report(name: str, ok: bool, detail: str = ""):
    global passed, failed
    status = "✅ PASS" if ok else "❌ FAIL"
    print(f"  {status}  {name}" + (f"  ({detail})" if detail else ""))
    if ok:
        passed += 1
    else:
        failed += 1


async def test_rust_get_state():
    """Test 1: GET /state returns valid JSON with entities."""
    print("\n── Test 1: Rust GET /state ──")
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{RUST_BASE}/state", timeout=5.0)
        report("Status 200", resp.status_code == 200, f"got {resp.status_code}")
        data = resp.json()
        has_entities = "entities" in data
        report("Has 'entities' key", has_entities)
        if has_entities:
            count = len(data["entities"])
            report(f"Entity count > 0", count > 0, f"{count} entities")
    except httpx.ConnectError:
        report("Connection to Rust engine", False, "Cannot connect to port 8080. Is the engine running?")
    except Exception as e:
        report("Unexpected error", False, str(e))


async def test_rust_spawn():
    """Test 2: POST /spawn creates entities that appear in GET /state."""
    print("\n── Test 2: Rust POST /spawn ──")
    try:
        async with httpx.AsyncClient() as client:
            # Get initial count
            before = await client.get(f"{RUST_BASE}/state", timeout=5.0)
            before_count = len(before.json().get("entities", {}))

            # Spawn 2 test entities
            spawn_payload = [
                {"ent_type": "enemy", "x": 400.0, "y": 400.0, "physics": "orbital", "faction": "pirate"},
                {"ent_type": "companion", "x": -400.0, "y": -400.0, "physics": "orbital", "faction": "federation"},
            ]
            resp = await client.post(f"{RUST_BASE}/spawn", json=spawn_payload, timeout=5.0)
            report("Spawn status 200", resp.status_code == 200, f"got {resp.status_code}")

            body = resp.json()
            report("Spawn response OK", body.get("status") == "spawned", json.dumps(body))

            # Verify entities increased
            await asyncio.sleep(0.1)
            after = await client.get(f"{RUST_BASE}/state", timeout=5.0)
            after_count = len(after.json().get("entities", {}))
            delta = after_count - before_count
            report(f"Entity count increased by >= 2", delta >= 2, f"before={before_count} after={after_count} delta={delta}")

    except httpx.ConnectError:
        report("Connection to Rust engine", False, "Cannot connect to port 8080")
    except Exception as e:
        report("Unexpected error", False, str(e))


async def test_python_director_ws():
    """Test 3: Python Director WebSocket accepts text command and returns WorldState."""
    print("\n── Test 3: Python Director WebSocket ──")
    try:
        import websockets
    except ImportError:
        report("websockets module", False, "pip install websockets")
        return

    try:
        async with websockets.connect(PYTHON_WS, open_timeout=5) as ws:
            report("WebSocket connected", True)

            # First message is the welcome
            welcome = await asyncio.wait_for(ws.recv(), timeout=5.0)
            welcome_data = json.loads(welcome)
            report("Welcome message received", welcome_data.get("type") == "text", welcome_data.get("content", "")[:60])

            # Send a text command
            cmd = json.dumps({"type": "text_command", "text": "Spawn 1 pirate raider near Earth"})
            await ws.send(cmd)
            report("Text command sent", True)

            # Collect messages for up to 30 seconds (LLM generation can be slow)
            found_world_state = False
            found_spawn = False
            deadline = asyncio.get_event_loop().time() + 30

            while asyncio.get_event_loop().time() < deadline:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    data = json.loads(msg)

                    if data.get("type") == "world_state":
                        found_world_state = True
                        content = data.get("content", {})
                        spawn_ents = content.get("spawn_entities", [])
                        if spawn_ents and len(spawn_ents) > 0:
                            found_spawn = True
                        report("WorldState received", True, f"summary={content.get('summary', 'N/A')}")
                        break
                    elif data.get("type") == "generation_result":
                        ws_data = data.get("world_state", {})
                        spawn_ents = ws_data.get("spawn_entities", [])
                        if spawn_ents and len(spawn_ents) > 0:
                            found_spawn = True
                        found_world_state = True
                        report("Generation result received", True)
                        break
                except asyncio.TimeoutError:
                    continue

            report("WorldState JSON received", found_world_state)
            report("spawn_entities present", found_spawn, f"{'found entries' if found_spawn else 'missing or empty'}")

    except (ConnectionRefusedError, OSError):
        report("WebSocket connection", False, "Cannot connect to Python Director on port 8000")
    except Exception as e:
        report("Unexpected error", False, str(e))


async def main():
    print("=" * 60)
    print("  THE VOID — Backend Sanity Test Suite")
    print("=" * 60)

    await test_rust_get_state()
    await test_rust_spawn()
    await test_python_director_ws()

    print("\n" + "=" * 60)
    print(f"  Results: {passed} passed, {failed} failed")
    print("=" * 60)

    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    asyncio.run(main())

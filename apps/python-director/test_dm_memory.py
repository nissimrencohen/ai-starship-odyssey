#!/usr/bin/env python3
"""
test_dm_memory.py — Standalone validation of Director Expansion Batch 2 memory systems.

Pre-mocks all heavy/API-dependent modules (FastAPI, LangChain, Groq, dotenv) via
sys.modules BEFORE importing main, so faiss + sentence_transformers run for real.
No React frontend or live API connections required.
"""
import sys
import os
from unittest.mock import MagicMock

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1: Pre-mock heavy/API-dependent modules BEFORE importing main
# ─────────────────────────────────────────────────────────────────────────────
_MOCK_MODULES = [
    "fastapi",
    "fastapi.staticfiles",
    "fastapi.middleware",
    "fastapi.middleware.cors",
    "groq",
    "langchain_groq",
    "langchain_core",
    "langchain_core.prompts",
    "langchain_core.output_parsers",
    "langchain_core.exceptions",
    "langchain_google_genai",
    "langchain_anthropic",
    "dotenv",
]

for mod in _MOCK_MODULES:
    sys.modules[mod] = MagicMock()

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2: Import main — now safe (no API calls will fire)
# ─────────────────────────────────────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main  # noqa: E402

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3: Guard — encoder must be online for any test to be meaningful
# ─────────────────────────────────────────────────────────────────────────────
if main.GLOBAL_ENCODER is None:
    print("FATAL: GLOBAL_ENCODER is None — sentence_transformers failed to load.")
    sys.exit(1)

print(f"[OK] GLOBAL_ENCODER loaded: {type(main.GLOBAL_ENCODER).__name__}\n")

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────
PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"
_results: list = []

def check(name: str, condition: bool, detail: str = "") -> None:
    status = PASS if condition else FAIL
    msg = f"  [{status}] {name}"
    if detail:
        msg += f"\n         detail: {detail}"
    print(msg)
    _results.append((name, condition))


# ─────────────────────────────────────────────────────────────────────────────
# TEST 1: ECOLOGY — Graveyard cluster
# ─────────────────────────────────────────────────────────────────────────────
print("=== TEST 1: ECOLOGY (Graveyard Cluster) ===")

dm1 = main.DreamMemory()
main.destruction_cluster_log.clear()

# 4 events × count=5 = 20 kills at cell (14000, 14000) → triggers graveyard embed
for _ in range(4):
    main.check_and_embed_graveyard(dm1, {
        "count": 5,
        "cause": "player_laser",
        "x": 15000.0,
        "z": 15000.0,
    })

ecology_entries = [e for e in dm1.memory_store if e["memory_type"] == "ECOLOGY"]
check("ECOLOGY graveyard embedded after 20 kills", len(ecology_entries) >= 1)
if ecology_entries:
    txt = ecology_entries[0]["text"]
    check("ECOLOGY text mentions sector grid cell 14000",
          "14000" in txt, txt[:100])
    check("ECOLOGY text contains 'graveyard'",
          "graveyard" in txt.lower(), txt[:100])
    check("ECOLOGY text mentions cause (player_laser)",
          "player_laser" in txt, txt[:100])

check("Destruction log cleared after embed",
      len(main.destruction_cluster_log) == 0,
      f"log size={len(main.destruction_cluster_log)}")

# Partial cluster (< 20 kills) must NOT embed
dm1b = main.DreamMemory()
main.destruction_cluster_log.clear()
main.check_and_embed_graveyard(dm1b, {"count": 3, "cause": "missile", "x": 5000.0, "z": 5000.0})
ecology_premature = [e for e in dm1b.memory_store if e["memory_type"] == "ECOLOGY"]
check("No ECOLOGY embed for partial cluster (3 kills)",
      len(ecology_premature) == 0,
      f"count={len(ecology_premature)}")


# ─────────────────────────────────────────────────────────────────────────────
# TEST 2: NEMESIS — Player death location
# ─────────────────────────────────────────────────────────────────────────────
print("\n=== TEST 2: NEMESIS (Player Death Location) ===")

dm2 = main.DreamMemory()
main.embed_nemesis_memory(
    dm2,
    {"cause": "elite_pirate", "count": 12},
    px=-5000.0, py=200.0, pz=2000.0,
)

nemesis_events = [e for e in dm2.sector_events if e.get("memory_type") == "NEMESIS"]
check("NEMESIS stored in sector_events (spatial list)",
      len(nemesis_events) == 1,
      f"count={len(nemesis_events)}")

if nemesis_events:
    ne = nemesis_events[0]
    check("NEMESIS x coordinate = -5000",
          abs(ne["x"] - (-5000.0)) < 0.1, f"x={ne['x']}")
    check("NEMESIS z coordinate = 2000",
          abs(ne["z"] - 2000.0) < 0.1, f"z={ne['z']}")
    check("NEMESIS text mentions cause (elite_pirate)",
          "elite_pirate" in ne["text"], ne["text"][:100])

nemesis_store = [e for e in dm2.memory_store if e["memory_type"] == "NEMESIS"]
check("NEMESIS also indexed in FAISS memory_store",
      len(nemesis_store) >= 1,
      f"count={len(nemesis_store)}")

# Retrieval: player near death coords → [NEMESIS] tag must appear
ctx2 = dm2.get_relevant_context(
    "battle near pirate territory", k=3, px=-5000.0, py=200.0, pz=2000.0
)
check("get_relevant_context includes [NEMESIS] when near death coords",
      "[NEMESIS]" in ctx2, ctx2[:150])


# ─────────────────────────────────────────────────────────────────────────────
# TEST 3: NARRATIVE — Lore regex extraction
# ─────────────────────────────────────────────────────────────────────────────
print("\n=== TEST 3: NARRATIVE (Lore Regex Extraction) ===")

dm3 = main.DreamMemory()
lore_reply = (
    "The Federation is building a secret weapon near the outer rim. "
    "A storm is coming."
)

main.extract_and_embed_lore(dm3, lore_reply, px=3000.0, pz=-8000.0)

narrative_entries = [e for e in dm3.memory_store if e["memory_type"] == "NARRATIVE"]
check("NARRATIVE memory embedded from lore reply",
      len(narrative_entries) == 1,
      f"count={len(narrative_entries)}")

if narrative_entries:
    txt = narrative_entries[0]["text"]
    check("NARRATIVE text contains 'UNRESOLVED LORE' tag",
          "UNRESOLVED LORE" in txt, txt[:120])
    check("NARRATIVE text contains sector reference",
          "Sector" in txt, txt[:120])

# Deduplication: same reply again must NOT add a second entry
main.extract_and_embed_lore(dm3, lore_reply, px=3000.0, pz=-8000.0)
narrative_after_dup = [e for e in dm3.memory_store if e["memory_type"] == "NARRATIVE"]
check("NARRATIVE dedup — second identical call produces no extra entry",
      len(narrative_after_dup) == 1,
      f"count={len(narrative_after_dup)}")

# Non-lore reply must NOT produce a NARRATIVE entry
main.extract_and_embed_lore(dm3, "Affirmative, pilot. Shields at full capacity.", px=3000.0, pz=-8000.0)
narrative_after_plain = [e for e in dm3.memory_store if e["memory_type"] == "NARRATIVE"]
check("Non-lore reply produces no NARRATIVE embed",
      len(narrative_after_plain) == 1,
      f"count={len(narrative_after_plain)}")

# Retrieval surfaces [NARRATIVE] tag
ctx3 = dm3.get_relevant_context("what is the Federation planning?", k=3)
check("get_relevant_context includes [NARRATIVE] tag",
      "[NARRATIVE]" in ctx3, ctx3[:150])


# ─────────────────────────────────────────────────────────────────────────────
# TEST 4: META_CONFIG — Config state change
# ─────────────────────────────────────────────────────────────────────────────
print("\n=== TEST 4: META_CONFIG (Config State Change) ===")

dm4 = main.DreamMemory()
world_state_data = {
    "audio_settings": {"ai_muted": True, "game_muted": False},
    "radar_filters": {"asteroid": False, "enemy": True},
}
main.embed_meta_config_memory(dm4, world_state_data, px=12000.0, pz=-3000.0)

meta_entries = [e for e in dm4.memory_store if e["memory_type"] == "META_CONFIG"]
check("META_CONFIG memory embedded",
      len(meta_entries) == 1,
      f"count={len(meta_entries)}")

if meta_entries:
    txt = meta_entries[0]["text"]
    check("META_CONFIG mentions ai_muted / Rachel muted voice",
          "ai_muted" in txt.lower() or "muted her own voice" in txt.lower(),
          txt[:140])
    check("META_CONFIG mentions asteroid radar hidden",
          "asteroid" in txt, txt[:140])
    check("META_CONFIG mentions sector coords",
          "12000" in txt or "Sector" in txt, txt[:140])

# Empty world_state_data → no embed
dm4b = main.DreamMemory()
main.embed_meta_config_memory(dm4b, {"summary": "all quiet"}, px=0.0, pz=0.0)
meta_empty = [e for e in dm4b.memory_store if e["memory_type"] == "META_CONFIG"]
check("No META_CONFIG embed when nothing changed",
      len(meta_empty) == 0,
      f"count={len(meta_empty)}")

# Retrieval surfaces [META_CONFIG] tag
ctx4 = dm4.get_relevant_context("system config and radar status", k=3)
check("get_relevant_context includes [META_CONFIG] tag",
      "[META_CONFIG]" in ctx4, ctx4[:150])


# ─────────────────────────────────────────────────────────────────────────────
# TEST 5 (Bonus): Blended retrieval — all 6 typed memories in one DreamMemory
# ─────────────────────────────────────────────────────────────────────────────
print("\n=== TEST 5: Blended Retrieval (all 6 memory types) ===")

dm5 = main.DreamMemory()

dm5.add_typed_memory(
    "Pilot archetype: aggressive berserker — maximises direct combat, ignores stealth",
    "PLAYER_PROFILE",
)
dm5.add_typed_memory(
    "Sector (14000, 14000): permanent graveyard, 20 asteroids cleared by player_laser",
    "ECOLOGY",
)
dm5.add_typed_memory(
    "Rachel muted her own voice output (ai_muted=True) in Sector (12000, -3000)",
    "META_CONFIG",
)
dm5.add_typed_memory(
    "[UNRESOLVED LORE — Sector (3000, -8000)] Rachel promised: "
    "\"The Federation is building a secret weapon\" — arc is active.",
    "NARRATIVE",
)
dm5.add_sector_event(
    "NEMESIS ALERT — pilot destroyed by elite_pirate (12 kills recorded)",
    -5000.0, 200.0, 2000.0,
    memory_type="NEMESIS",
)
dm5.add_sector_event(
    "Major battle at asteroid belt: 15 enemy fighters engaged near Sector (14500, 14500)",
    14500.0, 0.0, 14500.0,
    memory_type="SECTOR_EVENT",
)

ctx5 = dm5.get_relevant_context(
    "current threats, mission status, and config",
    k=50,  # large k → search_k covers all indexed entries, guaranteeing all types surface
    px=-5000.0, py=200.0, pz=2000.0,
)

print(f"  --- Blended context (first 600 chars) ---\n{ctx5[:600]}\n  ---")

check("Blended context includes [PLAYER PROFILE]",  "[PLAYER PROFILE]" in ctx5)
check("Blended context includes [ECOLOGY]",          "[ECOLOGY]"        in ctx5)
check("Blended context includes [META_CONFIG]",      "[META_CONFIG]"    in ctx5)
check("Blended context includes [NEMESIS]",          "[NEMESIS]"        in ctx5)
check("Blended context includes [NARRATIVE]",        "[NARRATIVE]"      in ctx5)


# ─────────────────────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────────────────────
passed = sum(1 for _, ok in _results if ok)
total  = len(_results)
print(f"\n{'='*55}")
print(f"RESULTS: {passed}/{total} checks passed")
if passed == total:
    print("ALL TESTS PASSED")
    sys.exit(0)
else:
    failed_names = [name for name, ok in _results if not ok]
    print(f"FAILED ({len(failed_names)}):")
    for n in failed_names:
        print(f"  - {n}")
    sys.exit(1)

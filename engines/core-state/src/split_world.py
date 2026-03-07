import os

def refactor_block(source_file, target_file, extract_segments):
    """
    extract_segments: list of (start_line_regex, end_line_regex) to extract.
    But regex limits me, so let's give exact line numbers based on the view_file.
    Lines to extract for world.rs:
    From "fn spawn_wave" (line 188) to end of "spawn_anomaly" (line 254)
    From "// ---------- World Persistence ----------" (line 256) to end of save_world_to_disk (line 356)
    From "fn rebuild_asteroids(world: &mut World) {" (line 415) to its end (line 461)
    """
    with open(source_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()
        
    world_lines = []
    
    # Write imports for world.rs
    world_imports = """use bevy_ecs::prelude::*;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::sync::atomic::Ordering;
use crate::components::*;
use crate::GLOBAL_ENTITY_ID;

pub const MAX_WORLD_RADIUS: f64 = 64000.0;
"""
    world_lines.extend([world_imports])

    blocks = [
        (187, 254), # spawn_wave, spawn_anomaly
        (256, 356), # Persistence
        (415, 461), # rebuild_asteroids
    ]
    
    # We must mark these lines for deletion by replacing them with empty strings
    for start, end in blocks:
        # 1-indexed to 0-indexed
        b_lines = lines[start-1:end]
        world_lines.extend(b_lines)
        for i in range(start-1, end):
            lines[i] = ""

    # Modify the extracted text to make functions public
    world_text = "".join(world_lines)
    world_text = world_text.replace("fn spawn_wave", "pub fn spawn_wave")
    world_text = world_text.replace("fn spawn_anomaly", "pub fn spawn_anomaly")
    world_text = world_text.replace("fn save_world_to_disk", "pub fn save_world_to_disk")
    world_text = world_text.replace("fn rebuild_asteroids", "pub fn rebuild_asteroids")

    with open(target_file, "w", encoding='utf-8') as f:
        f.write(world_text)
        
    # Also add "pub mod world;" to main.rs at the top
    # lines[0] is `mod components;`
    lines.insert(0, "pub mod world;\n")

    with open(source_file, "w", encoding="utf-8") as f:
        f.writelines(lines)
        
    print(f"Extracted world logic to {target_file}")

if __name__ == "__main__":
    refactor_block("main.rs", "world.rs", [])

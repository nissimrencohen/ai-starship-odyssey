import os

def main():
    lines = open("main.rs", encoding="utf-8").readlines()
    
    engine_state_str = """
use std::sync::{Arc, Mutex};
use bevy_ecs::prelude::*;
use crate::components::*;
use crate::{Clients, PlayerInputState, RealityModifiers};

#[derive(Clone)]
pub struct EngineState {
    pub world: Arc<Mutex<World>>,
    pub state: Arc<Mutex<WorldState>>,
    pub clients: Clients,
    pub player_target: Arc<Mutex<Option<(f64, f64)>>>,
    pub player_input_state: Arc<Mutex<PlayerInputState>>,
    pub reality_modifiers: Arc<Mutex<RealityModifiers>>,
    pub player_health: Arc<Mutex<f64>>,
    pub damage_cooldown: Arc<Mutex<f64>>,
    pub player_knockback: Arc<Mutex<(f64, f64)>>,
    pub total_kills: Arc<Mutex<u32>>,
    pub total_enemy_kills: Arc<Mutex<u32>>,
    pub total_asteroid_kills: Arc<Mutex<u32>>,
    pub level_start_time: Arc<Mutex<std::time::Instant>>,
    pub game_over_timer: Arc<Mutex<f64>>,
    pub force_next_level: Arc<Mutex<bool>>,
    pub do_full_reset: Arc<Mutex<bool>>,
    pub override_level: Arc<Mutex<Option<u32>>>,
    pub current_level_shared: Arc<Mutex<u32>>,
}
"""
    with open("engine_state.rs", "w", encoding="utf-8") as f:
        f.write(engine_state_str)

    # I'll create game_loop.rs but I need everything after 'Main Game Loop ('
    start_idx = 0
    for i, ln in enumerate(lines):
        if 'Main Game Loop (' in ln:
            start_idx = i
            break
            
    game_loop_lines = lines[start_idx:]
    lines = lines[:start_idx] # now lines only contains up to API
    
    # Write game_loop.rs
    with open("game_loop.rs", "w", encoding="utf-8") as f:
        f.write("use crate::*;\n")
        f.write("use crate::components::*;\n")
        f.write("use crate::systems::*;\n")
        f.write("use crate::world::*;\n")
        f.write("use crate::api::*;\n")
        f.write("use crate::engine_state::EngineState;\n")
        f.write("use std::sync::{Arc, Mutex};\n")
        f.write("use tokio::sync::mpsc;\n")
        f.write("use std::time::Instant;\n")
        f.write("use warp::ws::Message;\n")
        f.write("use bevy_ecs::prelude::*;\n")
        f.write("\n")
        f.write("pub async fn run(engine_state: EngineState) {\n")
        
        # We need to map the cloned vars back to `engine_state...`
        f.write("    let player_target_for_loop = engine_state.player_target;\n")
        f.write("    let player_health_for_loop = engine_state.player_health;\n")
        f.write("    let damage_cooldown_for_loop = engine_state.damage_cooldown;\n")
        f.write("    let player_knockback_for_loop = engine_state.player_knockback;\n")
        f.write("    let total_kills_for_loop = engine_state.total_kills;\n")
        f.write("    let total_enemy_kills_for_loop = engine_state.total_enemy_kills;\n")
        f.write("    let total_asteroid_kills_for_loop = engine_state.total_asteroid_kills;\n")
        f.write("    let level_start_time_for_loop = engine_state.level_start_time;\n")
        f.write("    let game_over_timer_for_loop = engine_state.game_over_timer;\n")
        f.write("    let force_next_level_for_loop = engine_state.force_next_level;\n")
        f.write("    let do_full_reset_for_loop = engine_state.do_full_reset;\n")
        f.write("    let override_level_for_loop = engine_state.override_level;\n")
        f.write("    let current_level_shared_for_loop = engine_state.current_level_shared;\n")
        f.write("    let player_input_state = engine_state.player_input_state;\n")
        f.write("    let reality_for_sys = engine_state.reality_modifiers;\n")
        f.write("    let world = engine_state.world;\n")
        f.write("    let state = engine_state.state;\n")
        f.write("    let clients = engine_state.clients;\n")
        f.write("\n")
        # Since schedule is inside main(), I need to move schedule into game_loop.rs
        f.write("    let mut schedule = Schedule::default();\n")
        f.write("    schedule.add_systems((\n")
        f.write("        crate::sync_state_system,\n")
        f.write("        systems::generative_physics_system,\n")
        f.write("        systems::environmental_physics_system,\n")
        f.write("        systems::particle_physics_system,\n")
        f.write("        systems::steering_system,\n")
        f.write("    ));\n\n")

        # skip the lines where the old `let _for_loop = ...` were (first 13 lines of game_loop_lines)
        offset = 14
        for ln in game_loop_lines[offset:]:
            f.write(ln)
            
    # Now patch main.rs
    lines.insert(0, "pub mod engine_state;\npub mod game_loop;\n")
    
    # We must delete schedule in main.rs since it's going to game_loop
    # find lines for Schedule
    schedule_start = -1
    for i, ln in enumerate(lines):
        if "let mut schedule = Schedule::default();" in ln:
            schedule_start = i
            break
            
    if schedule_start != -1:
        for i in range(schedule_start, schedule_start + 10):
            lines[i] = ""

    # At the end of main.rs (which is now just the API setup), we insert EngineState
    lines.append("""
    let engine_state = engine_state::EngineState {
        world: world.clone(),
        state: state.clone(),
        clients: clients.clone(),
        player_target: player_target.clone(),
        player_input_state: player_input_state.clone(),
        reality_modifiers: reality_modifiers.clone(),
        player_health: player_health.clone(),
        damage_cooldown: damage_cooldown.clone(),
        player_knockback: player_knockback.clone(),
        total_kills: total_kills.clone(),
        total_enemy_kills: total_enemy_kills.clone(),
        total_asteroid_kills: total_asteroid_kills.clone(),
        level_start_time: level_start_time.clone(),
        game_over_timer: game_over_timer.clone(),
        force_next_level: force_next_level.clone(),
        do_full_reset: do_full_reset.clone(),
        override_level: override_level.clone(),
        current_level_shared: current_level_shared.clone(),
    };
    
    game_loop::run(engine_state).await;
}
""")

    with open("main.rs", "w", encoding="utf-8") as f:
        f.writelines(lines)

    print("Extracted game_loop.rs!")

if __name__ == "__main__":
    main()

import os

def extract_routes():
    lines = open("main.rs", encoding="utf-8").readlines()
    
    start_idx = 309 - 1
    end_idx = 1031 - 1
    
    route_lines = lines[start_idx:end_idx]
    
    with open("api.rs", "a", encoding="utf-8") as f:
        f.write("\nuse warp::Filter;\n")
        f.write("use std::sync::{Arc, Mutex};\n")
        f.write("use crate::engine_state::EngineState;\n")
        f.write("use crate::components::*;\n")
        f.write("use crate::world::*;\n")
        f.write("use bevy_ecs::prelude::*;\n")
        f.write("use crate::{Clients, PlayerInputState, RealityModifiers};\n")
        f.write("use crate::GLOBAL_ENTITY_ID;\n")
        f.write("use std::sync::atomic::Ordering;\n")
        f.write("use crate::game_loop::client_connection;\n")
        f.write("\n")
        f.write("pub async fn start_api_server(engine_state: EngineState) {\n")
        
        # We need to map engine_state to local variables used by the routes
        vars_to_extract = [
            "world", "state", "clients", "player_target", "player_input_state",
            "reality_modifiers", "player_health", "damage_cooldown", "player_knockback",
            "total_kills", "total_enemy_kills", "total_asteroid_kills",
            "level_start_time", "game_over_timer", "do_full_reset", "override_level",
            "force_next_level", "current_level_shared"
        ]
        
        for v in vars_to_extract:
            f.write(f"    let {v} = engine_state.{v}.clone();\n")
            
        f.write("\n")
        for ln in route_lines:
            f.write(ln)
            
        f.write("}\n")
        
    # Replace the chunk with api::start_api_server
    new_lines = lines[:start_idx] + ["    crate::api::start_api_server(engine_state.clone()).await;\n"] + lines[end_idx:]
    
    with open("main.rs", "w", encoding="utf-8") as f:
        f.writelines(new_lines)

if __name__ == '__main__':
    extract_routes()

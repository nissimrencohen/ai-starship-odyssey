import os

def fix_main():
    with open('main.rs', 'r', encoding='utf-8') as f:
        lines = f.readlines()
        
    api_call_idx = -1
    for i, ln in enumerate(lines):
        if "crate::api::start_api_server(engine_state.clone()).await;" in ln:
            api_call_idx = i
            break
            
    if api_call_idx != -1:
        lines[api_call_idx] = ""
        
    engine_state_idx = -1
    for i, ln in enumerate(lines):
        if "game_loop::run(engine_state).await;" in ln:
            engine_state_idx = i
            break
            
    if engine_state_idx != -1:
        lines.insert(engine_state_idx, "    crate::api::start_api_server(engine_state.clone()).await;\n")
        
    # Find where to put variables
    insert_var_idx = -1
    for i, ln in enumerate(lines):
        if "    } // drop the lock held during init" in ln:
            insert_var_idx = i + 1
            break

    variables = """
    let clients: Clients = Arc::new(Mutex::new(Vec::new()));
    let player_input_state = Arc::new(Mutex::new(PlayerInputState::default()));
    let reality_modifiers: Arc<Mutex<RealityModifiers>> = Arc::new(Mutex::new(RealityModifiers::default()));

    let player_health: Arc<Mutex<f64>> = Arc::new(Mutex::new(100.0));
    let damage_cooldown: Arc<Mutex<f64>> = Arc::new(Mutex::new(0.0));
    let player_knockback: Arc<Mutex<(f64, f64)>> = Arc::new(Mutex::new((0.0, 0.0)));
    let total_kills: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
    let total_enemy_kills: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
    let total_asteroid_kills: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
    let level_start_time: Arc<Mutex<std::time::Instant>> = Arc::new(Mutex::new(std::time::Instant::now()));
    let game_over_timer: Arc<Mutex<f64>> = Arc::new(Mutex::new(0.0));
    let do_full_reset: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
    let override_level: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
    let current_level_shared: Arc<Mutex<u32>> = Arc::new(Mutex::new(1));
    let force_next_level: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
"""
    if insert_var_idx != -1:
        lines.insert(insert_var_idx, variables)
        
    with open('main.rs', 'w', encoding='utf-8') as f:
        f.writelines(lines)

if __name__ == '__main__':
    fix_main()

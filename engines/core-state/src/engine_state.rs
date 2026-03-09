use crate::components::*;
use crate::{Clients, PlayerInputState, RealityModifiers};
use bevy_ecs::prelude::*;
use std::sync::{Arc, Mutex};

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
    pub level_transition_timer: Arc<Mutex<f64>>,
    pub is_paused: Arc<Mutex<bool>>,
}

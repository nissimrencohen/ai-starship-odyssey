use crate::components::AudioSettings;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct EntityData {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub rotation: f64,
    pub speed: f64,
    pub ent_type: String,
    pub color: String,
    pub is_newborn: bool,
    pub is_dying: bool,
    pub behavior: String,
    pub faction: String,
    pub name: Option<String>,
    pub radius: Option<f64>,
    pub anomaly_type: Option<String>,
    pub anomaly_radius: Option<f64>,
    pub model_type: Option<String>,
    pub custom_color: Option<String>,
    pub parent_id: Option<u32>,
    pub spawn_age: Option<f64>,
    pub persistent_id: Option<u64>,
    pub target_lock_id: Option<u32>,
    pub is_cloaked: bool,
    pub scale: Option<f64>,
    pub model_variant: Option<u32>,
    pub projectile_size: Option<f64>,
    pub health_current: Option<f64>,
    pub health_max: Option<f64>,
}

#[derive(Deserialize, Debug)]
pub struct SpawnEntityRequest {
    pub ent_type: String,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub z: f64,
    pub physics: String,
    pub faction: Option<String>,
    pub radius: Option<f64>,
    pub speed: Option<f64>,
    pub amplitude: Option<f64>,
    pub frequency: Option<f64>,
    pub anomaly_type: Option<String>,
    pub mass: Option<f64>,
    pub color: Option<String>,
    pub model_type: Option<String>,
    pub fire_rate_multiplier: Option<f64>,
    pub behavior: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct DespawnRequest {
    pub ent_type: Option<String>,
    pub color: Option<String>,
    pub ids: Option<Vec<u32>>,
}

#[derive(Deserialize, Debug)]
pub struct ModifyRequest {
    pub id: u32,
    pub physics: Option<String>,
    pub color: Option<String>,
    pub radius: Option<f64>,
    pub speed: Option<f64>,
    pub amplitude: Option<f64>,
    pub frequency: Option<f64>,
    pub behavior: Option<String>,
}

/// Request body for POST /api/set-planet-radius
/// Updates the SpatialAnomaly (collision) radius of a named planet/moon/sun.
/// Called by the Python Director whenever planet_scale_overrides change so that
/// physics collision matches the visual size.
#[derive(Deserialize, Debug)]
pub struct SetPlanetRadiusRequest {
    pub name: String,
    pub radius: f64,
}

/// Request body for POST /api/physics
#[derive(Deserialize, Debug)]
pub struct PhysicsUpdateRequest {
    pub gravity_scale: Option<f64>,
    pub friction: Option<f64>,
    pub projectile_speed_mult: Option<f64>,
}

/// Single faction-pair affinity update for POST /api/factions
#[derive(Deserialize, Debug)]
pub struct FactionPairUpdate {
    pub faction_a: String,
    pub faction_b: String,
    pub affinity: f64,
}

#[derive(Serialize)]
pub struct CollisionEvent {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub star_id: u32,
    pub speed: f64,
    pub distance: f64,
}

#[derive(Serialize)]
pub struct SpatialGrid {
    pub size: f64,
    pub divisions: u32,
}

#[derive(Serialize)]
pub struct ParticleData {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub lifespan: f64,
    pub max_lifespan: f64,
    pub color: String,
}

#[derive(Serialize)]
pub struct RenderFrameState {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub environment_theme: String,
    pub terrain_rules: String,
    pub grid: SpatialGrid,
    pub entities: Vec<EntityData>,
    pub particles: Vec<ParticleData>,
    pub player_health: f64,
    pub score: u32,
    pub current_level: u32,
    pub is_game_over: bool,
    pub is_transitioning: bool,
    pub black_hole_death: bool,
    pub objective: String,
    pub kills_in_level: u32,
    pub success_kill: bool,
    pub radar_filters: std::collections::HashMap<String, bool>,
    pub audio_settings: AudioSettings,
}

use crate::components::*;
use crate::engine_state::EngineState;
use crate::game_loop::client_connection;
use crate::world::*;
use crate::GLOBAL_ENTITY_ID;
use crate::{Clients, RealityModifiers};
use bevy_ecs::prelude::*;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use warp::Filter;

pub async fn start_api_server(engine_state: EngineState) {
    let world = engine_state.world.clone();
    let state = engine_state.state.clone();
    let clients = engine_state.clients.clone();
    let player_target = engine_state.player_target.clone();
    let player_input_state = engine_state.player_input_state.clone();
    let reality_modifiers = engine_state.reality_modifiers.clone();
    let player_health = engine_state.player_health.clone();
    let _damage_cooldown = engine_state.damage_cooldown.clone();
    let _player_knockback = engine_state.player_knockback.clone();
    let total_kills = engine_state.total_kills.clone();
    let total_enemy_kills = engine_state.total_enemy_kills.clone();
    let total_asteroid_kills = engine_state.total_asteroid_kills.clone();
    let _level_start_time = engine_state.level_start_time.clone();
    let game_over_timer = engine_state.game_over_timer.clone();
    let do_full_reset = engine_state.do_full_reset.clone();
    let override_level = engine_state.override_level.clone();
    let force_next_level = engine_state.force_next_level.clone();
    let current_level_shared = engine_state.current_level_shared.clone();
    let is_paused = engine_state.is_paused.clone();

    let state_for_routes = state.clone();
    let state_filter = warp::any().map(move || state_for_routes.clone());

    let clients_for_state = clients.clone();
    let player_target_for_state = player_target.clone();
    let _reality_for_sys = reality_modifiers.clone();
    let reality_for_state = reality_modifiers.clone();

    let world_for_state = world.clone();
    let update_state = warp::post()
        .and(warp::path("state"))
        .and(warp::body::json())
        .and(state_filter.clone())
        .and(warp::any().map(move || world_for_state.clone()))
        .and(warp::any().map(move || clients_for_state.clone()))
        .and(warp::any().map(move || player_target_for_state.clone()))
        .and(warp::any().map(move || reality_for_state.clone()))
        .map(
            |new_state: WorldState,
             state: Arc<Mutex<WorldState>>,
             world: Arc<Mutex<World>>,
             _clients: Clients,
             pt: Arc<Mutex<Option<(f64, f64)>>>,
             rm: Arc<Mutex<RealityModifiers>>| {
                println!("Received new WorldState: {:?}", new_state.summary);

                let mut current_state = state.lock().unwrap();

                // Check if mission parameters changed to trigger asteroid rebuild
                let mut rebuild_needed = false;
                if let Some(ref new_params) = new_state.mission_parameters {
                    let mut w = world.lock().unwrap();
                    if let Some(ref old_params) = current_state.mission_parameters {
                        if new_params.seed != old_params.seed
                            || new_params.density != old_params.density
                        {
                            rebuild_needed = true;
                            // IMPORTANT: Update the ECS resource so rebuild_asteroids sees the new values
                            w.insert_resource(new_params.clone());
                        }
                    } else {
                        rebuild_needed = true;
                        w.insert_resource(new_params.clone());
                    }
                }

                // High-Priority Player Override: stage lerp target if coordinates arrived.
                // Option Safety: None means this was a zoom-only update — player untouched.
                if let (Some(px), Some(py)) = (new_state.player_x, new_state.player_y) {
                    println!("[Director Override] Player target set to ({}, {})", px, py);
                    *pt.lock().unwrap() = Some((px, py));
                }

                if let Some(ro) = &new_state.reality_override {
                    let mut modifiers = rm.lock().unwrap();
                    if let Some(g) = ro.gravity_multiplier {
                        modifiers.gravity = g;
                    }
                    if let Some(ps) = ro.player_speed_multiplier {
                        modifiers.player_speed = ps;
                    }
                    if let Some(f) = ro.global_friction {
                        modifiers.friction = f;
                    }
                    println!(
                        "[Director] Reality Override Applied -> G: {}, PS: {}, Fric: {}",
                        modifiers.gravity, modifiers.player_speed, modifiers.friction
                    );
                }

                *current_state = new_state.clone();

                if rebuild_needed {
                    let mut w = world.lock().unwrap();
                    rebuild_asteroids(&mut w);
                }

                warp::reply::json(&*current_state)
            },
        );

    let clients_for_filter = clients.clone();
    let clients_filter = warp::any().map(move || clients_for_filter.clone());
    let input_state_for_ws = player_input_state.clone();
    let input_filter = warp::any().map(move || input_state_for_ws.clone());

    let ws_route = warp::path("ws")
        .and(warp::ws())
        .and(clients_filter.clone())
        .and(input_filter.clone())
        .map(|ws: warp::ws::Ws, clients, input_state| {
            ws.on_upgrade(move |socket| client_connection(socket, clients, input_state))
        });

    // POST /save — persist the world snapshot to disk
    let world_for_save = world.clone();
    let state_for_save = state.clone();
    let player_health_for_save = player_health.clone();
    let total_kills_for_save = total_kills.clone();
    let current_level_for_save = current_level_shared.clone();
    let save_route = warp::post().and(warp::path("save")).map(move || {
        let health = *player_health_for_save.lock().unwrap();
        let kills = *total_kills_for_save.lock().unwrap();
        let level = *current_level_for_save.lock().unwrap();
        let mut w = world_for_save.lock().unwrap();
        match save_world_to_disk(&mut w, &state_for_save, health, kills, level) {
            Ok(_) => warp::reply::json(&serde_json::json!({ "status": "saved" })),
            Err(e) => {
                eprintln!("Save failed: {}", e);
                warp::reply::json(&serde_json::json!({ "status": "error", "message": e }))
            }
        }
    });

    // POST /spawn — Dynamically add entities from the AI Director
    let world_for_spawn = world.clone();
    let spawn_route = warp::post()
        .and(warp::path("spawn"))
        .and(warp::body::json())
        .map(move |requests: Vec<SpawnEntityRequest>| {
            println!("[Spawn API] Received {} entities to spawn", requests.len());
            let mut w = world_for_spawn.lock().unwrap();
            for req in &requests {
                let phys_type = match req.physics.as_str() {
                    "orbital" => {
                        // Derive radius from x/y if not explicitly provided.
                        // This maps the LLM's positional intent (e.g. x:450,y:450) to the
                        // correct heliocentric orbital distance instead of defaulting to 150.
                        let derived_radius = req
                            .radius
                            .unwrap_or_else(|| (req.x * req.x + req.y * req.y).sqrt().max(150.0));
                        // Preserve the initial angle so the entity spawns in the right quadrant
                        let derived_angle = req.y.atan2(req.x);
                        PhysicsType::Orbital {
                            radius: derived_radius,
                            speed: req.speed.unwrap_or(1.5),
                            angle: derived_angle,
                        }
                    }
                    "sinusoidal" => PhysicsType::Sinusoidal {
                        amplitude: req.amplitude.unwrap_or(100.0),
                        frequency: req.frequency.unwrap_or(3.0),
                        time: 0.0,
                    },
                    _ => PhysicsType::Static,
                };
                let faction_str = req.faction.clone().unwrap_or_else(|| "neutral".to_string());
                let mut ent_mut = w.spawn((
                    EntityType(req.ent_type.clone()),
                    Transform {
                        x: req.x,
                        y: req.y,
                        z: req.z,
                        rotation: 0.0,
                    },
                    phys_type,
                    BirthAge(0.0), // Starts the 2-second glow/acceleration effect
                    Faction(faction_str.clone()),
                ));
                // Add SteeringAgent for enemy/companion types so they can participate in faction combat
                if req.ent_type == "enemy" || req.ent_type == "companion" || req.ent_type == "neutral" {
                    let default_behavior = if req.behavior.is_some() {
                        req.behavior.clone().unwrap()
                    } else if req.ent_type == "neutral" {
                        "neutral_wander".to_string()
                    } else {
                        "idle".to_string()
                    };
                    ent_mut.insert(SteeringAgent {
                        behavior: default_behavior.to_string(),
                        velocity: (0.0, 0.0, 0.0),
                        max_speed: if req.ent_type == "neutral" { 40.0 } else { 80.0 },
                        max_force: if req.ent_type == "neutral" { 1.0 } else { 2.0 },
                    });
                }
                if let Some(color) = &req.color {
                    let m_type = req.model_type.clone().unwrap_or_else(|| req.ent_type.clone());
                    ent_mut.insert(Visuals {
                        model_type: Some(m_type),
                        color: color.clone(),
                        is_cloaked: false,
                    });
                    // Also initialize WeaponParameters with the same color
                    ent_mut.insert(WeaponParameters {
                        projectile_color: color.clone(),
                        fire_rate_multiplier: req.fire_rate_multiplier.unwrap_or(1.0),
                        ..Default::default()
                    });
                } else if req.ent_type == "enemy" {
                    // Default enemy visuals
                    ent_mut.insert(Visuals {
                        model_type: Some("enemy".to_string()),
                        color: "#ef4444".to_string(),
                        is_cloaked: false,
                    });
                    ent_mut.insert(WeaponParameters {
                        fire_rate_multiplier: req.fire_rate_multiplier.unwrap_or(1.0),
                        ..Default::default()
                    });
                }
                if let Some(atype) = req.anomaly_type.clone() {
                    ent_mut.insert(SpatialAnomaly {
                        anomaly_type: atype,
                        mass: req.mass.unwrap_or(5000.0),
                        radius: req.radius.unwrap_or(50.0),
                    });
                }
            }
            warp::reply::json(&serde_json::json!({ "status": "spawned", "count": requests.len() }))
        });

    // Apply CORS to State API (port 8080) - allow frontend origin
    let state_cors = warp::cors()
        .allow_origin("http://localhost:5173")
        .allow_methods(vec!["GET", "POST", "OPTIONS"])
        .allow_headers(vec!["Content-Type"]);

    // POST /clear — Mark all non-player entities for death
    let world_for_clear = world.clone();
    let clear_route = warp::post().and(warp::path("clear")).map(move || {
        let mut w = world_for_clear.lock().unwrap();
        let mut query = w.query::<(Entity, &EntityType, Option<&DeathAge>)>();
        let mut to_kill = Vec::new();
        for (entity, ent_type, death_age) in query.iter(&w) {
            // Ensure type inference by checking for exact type
            let dying: bool = death_age.is_some();
            if ent_type.0 != "player" && !dying {
                to_kill.push(entity);
            }
        }
        let count = to_kill.len();
        for e in to_kill {
            w.entity_mut(e).insert(DeathAge(0.0));
        }
        warp::reply::json(&serde_json::json!({ "status": "cleared", "count": count }))
    });

    // POST /despawn — Mark specific entities for death based on filters
    let world_for_despawn = world.clone();
    let despawn_route = warp::post()
        .and(warp::path("despawn"))
        .and(warp::body::json())
        .map(move |req: DespawnRequest| {
            let mut w = world_for_despawn.lock().unwrap();
            let mut query = w.query::<(Entity, &EntityType, Option<&DeathAge>)>();
            let mut to_kill = Vec::new();

            for (entity, ent_type, death_age) in query.iter(&w) {
                let dying: bool = death_age.is_some();
                if ent_type.0 == "player" || dying {
                    continue;
                }

                let id_match = req
                    .ids
                    .as_ref()
                    .map_or(false, |ids| ids.contains(&entity.index()));
                let type_match = req.ent_type.as_ref().map_or(false, |t| t == &ent_type.0);

                // Color filtering requires querying PhysicsType, but for simplicity we rely on ent_type mapping
                let color_str = match ent_type.0.as_str() {
                    "player" => "player",
                    "companion" => "companion",
                    "star" => "star",
                    _ => "other",
                };
                let color_match = req.color.as_ref().map_or(false, |c| c == color_str);

                if id_match || type_match || color_match {
                    to_kill.push(entity);
                }
            }

            let count = to_kill.len();
            for e in to_kill {
                w.entity_mut(e).insert(DeathAge(0.0));
            }
            warp::reply::json(&serde_json::json!({ "status": "despawned", "count": count }))
        });

    // POST /modify — Update physics parameters for specific entities
    let world_for_modify = world.clone();
    let modify_route = warp::post()
        .and(warp::path("modify"))
        .and(warp::body::json())
        .map(move |requests: Vec<ModifyRequest>| {
            let mut w = world_for_modify.lock().unwrap();
            let mut modified_count = 0;

            for req in requests {
                // Find entity by ID by iterating (since Bevy Entity requires generation which we don't have)
                // In a real app we'd maintain an ID -> Entity map, but for <200 entities loop is fine
                let mut target_entity = None;
                {
                    let mut query = w.query::<(Entity,)>();
                    for (e,) in query.iter(&w) {
                        if e.index() == req.id {
                            target_entity = Some(e);
                            break;
                        }
                    }
                }

                if let Some(e) = target_entity {
                    // Update base physics if requested
                    if let Some(ref ptype_str) = req.physics {
                        let new_phys = match ptype_str.as_str() {
                            "orbital" => PhysicsType::Orbital {
                                radius: req.radius.unwrap_or(150.0),
                                speed: req.speed.unwrap_or(1.5),
                                angle: 0.0,
                            },
                            "sinusoidal" => PhysicsType::Sinusoidal {
                                amplitude: req.amplitude.unwrap_or(100.0),
                                frequency: req.frequency.unwrap_or(3.0),
                                time: 0.0,
                            },
                            _ => PhysicsType::Static,
                        };
                        w.entity_mut(e).insert(new_phys);
                    } else {
                        // Modify existing physics parameters without resetting type/time
                        if let Some(mut phys) = w.get_mut::<PhysicsType>(e) {
                            match *phys {
                                PhysicsType::Orbital {
                                    ref mut radius,
                                    ref mut speed,
                                    ..
                                } => {
                                    if let Some(r) = req.radius {
                                        *radius = r;
                                    }
                                    if let Some(s) = req.speed {
                                        *speed = s;
                                    }
                                }
                                PhysicsType::Sinusoidal {
                                    ref mut amplitude,
                                    ref mut frequency,
                                    ..
                                } => {
                                    if let Some(a) = req.amplitude {
                                        *amplitude = a;
                                    }
                                    if let Some(f) = req.frequency {
                                        *frequency = f;
                                    }
                                }
                                _ => {}
                            }
                        }
                    }

                    // Update behavior policy if requested
                    if let Some(ref behavior) = req.behavior {
                        if let Some(mut steering) = w.get_mut::<SteeringAgent>(e) {
                            steering.behavior = behavior.clone();
                        }
                    }
                    modified_count += 1;
                }
            }
            warp::reply::json(&serde_json::json!({ "status": "modified", "count": modified_count }))
        });

    // POST /api/set-planet-radius — sync visual scale → physics collision radius
    // Called by Python Director when planet_scale_overrides change.
    let world_for_planet_radius = world.clone();
    let set_planet_radius_route = warp::post()
        .and(warp::path("set-planet-radius"))
        .and(warp::body::json())
        .map(move |req: SetPlanetRadiusRequest| {
            let mut w = world_for_planet_radius.lock().unwrap();
            let mut found = false;
            // Find any entity (planet, moon, sun) whose Name matches
            let mut target_entity = None;
            {
                let mut query = w.query::<(Entity, &Name)>();
                for (e, name) in query.iter(&w) {
                    if name.0 == req.name {
                        target_entity = Some(e);
                        break;
                    }
                }
            }
            if let Some(e) = target_entity {
                if let Some(mut sa) = w.get_mut::<SpatialAnomaly>(e) {
                    sa.radius = req.radius;
                    found = true;
                }
            }
            warp::reply::json(&serde_json::json!({ "status": if found { "updated" } else { "not_found" }, "name": req.name, "radius": req.radius }))
        });

    // GET /state — return a snapshot of active entities to the Python Director
    let world_for_get_state = world.clone();
    let get_state_route = warp::get().and(warp::path("state")).map(move || {
        let mut w = world_for_get_state.lock().unwrap();
        let mut entities_map = serde_json::Map::new();

        let mut query = w.query::<(
            Entity,
            &EntityType,
            Option<&SteeringAgent>,
            Option<&Transform>,
        )>();
        for (entity, ent_type, steering_opt, trans_opt) in query.iter(&w) {
            let id_str = entity.index().to_string();
            let behavior = steering_opt
                .map(|s| s.behavior.clone())
                .unwrap_or_else(|| "none".to_string());

            let mut ent_obj = serde_json::Map::new();
            ent_obj.insert(
                "id".to_string(),
                serde_json::Value::Number(serde_json::Number::from(entity.index())),
            );
            ent_obj.insert(
                "ent_type".to_string(),
                serde_json::Value::String(ent_type.0.clone()),
            );
            ent_obj.insert("behavior".to_string(), serde_json::Value::String(behavior));

            if let Some(t) = trans_opt {
                ent_obj.insert("x".to_string(), serde_json::json!(t.x));
                ent_obj.insert("y".to_string(), serde_json::json!(t.y));
            }

            entities_map.insert(id_str, serde_json::Value::Object(ent_obj));
        }

        warp::reply::json(&serde_json::json!({ "entities": entities_map }))
    });

    // POST /update_player — Dynamically customize the player's ship
    let world_for_update_player = world.clone();
    let update_player_route = warp::post()
        .and(warp::path("update_player"))
        .and(warp::body::json())
        .map(move |req: UpdatePlayerRequest| {
            let mut w = world_for_update_player.lock().unwrap();
            let mut query = w.query::<(Entity, &EntityType)>();
            let mut player_entity = None;
            for (e, ent_type) in query.iter(&w) {
                if ent_type.0 == "player" {
                    player_entity = Some(e);
                    break;
                }
            }
            if let Some(e) = player_entity {
                if let Some(mut visuals) = w.get_mut::<Visuals>(e) {
                    if let Some(mt) = req.model_type {
                        visuals.model_type = Some(mt);
                    }
                    if let Some(c) = req.color {
                        visuals.color = c;
                    }
                    if let Some(cloaked) = req.is_cloaked {
                        visuals.is_cloaked = cloaked;
                    }
                } else {
                    w.entity_mut(e).insert(Visuals {
                        model_type: Some(req.model_type.unwrap_or_else(|| "ufo".to_string())),
                        color: req.color.unwrap_or_else(|| "white".to_string()),
                        is_cloaked: req.is_cloaked.unwrap_or(false),
                    });
                }
            }
            warp::reply::json(&serde_json::json!({ "status": "updated_player" }))
        });

    // POST /api/engine/reset — Full game reset: despawn enemies, re-seed world, reset all stats
    let _world_for_reset = world.clone();
    let state_for_reset = state.clone();
    let reality_for_reset = reality_modifiers.clone();
    let player_target_for_reset = player_target.clone();
    let player_health_for_reset = player_health.clone();
    let total_kills_for_reset = total_kills.clone();
    let total_enemy_kills_for_reset = total_enemy_kills.clone();
    let total_asteroid_kills_for_reset = total_asteroid_kills.clone();
    let game_over_timer_for_reset = game_over_timer.clone();
    let do_full_reset_for_reset = do_full_reset.clone();
    let reset_route = warp::post()
        .and(warp::path!("api" / "engine" / "reset"))
        .map(move || {
            println!("[Engine] Full Reset triggered.");

            // 1. Reset Global Reality Modifiers
            *reality_for_reset.lock().unwrap() = RealityModifiers::default();

            // 2. Reset Shared WorldState
            *state_for_reset.lock().unwrap() = WorldState::default();

            // 3. Clear pending player targets
            *player_target_for_reset.lock().unwrap() = None;

            // 4. Reset survival stats
            *player_health_for_reset.lock().unwrap() = 100.0;
            *total_kills_for_reset.lock().unwrap() = 0;
            *total_enemy_kills_for_reset.lock().unwrap() = 0;
            *total_asteroid_kills_for_reset.lock().unwrap() = 0;
            *game_over_timer_for_reset.lock().unwrap() = 0.0;

            // 5. Signal game loop to reset level, despawn enemies, teleport player
            *do_full_reset_for_reset.lock().unwrap() = true;

            warp::reply::json(&serde_json::json!({ "status": "full_reset_initiated" }))
        });

    // POST /load — Restore a previously saved snapshot
    let world_for_load = world.clone();
    let state_for_load = state.clone();
    let player_health_for_load = player_health.clone();
    let total_kills_for_load = total_kills.clone();
    let total_enemy_kills_for_load = total_enemy_kills.clone();
    let total_asteroid_kills_for_load = total_asteroid_kills.clone();
    let game_over_timer_for_load = game_over_timer.clone();
    let override_level_for_load = override_level.clone();
    let load_route = warp::post()
        .and(warp::path("load"))
        .map(move || {
            // Read snapshot file
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent().and_then(|p| p.parent())
                .map(|p| p.join("world_snap.json"))
                .unwrap_or_else(|| std::path::PathBuf::from("world_snap.json"));

            let data = match std::fs::read_to_string(&path) {
                Ok(s) => s,
                Err(e) => return warp::reply::json(&serde_json::json!({ "status": "error", "message": format!("Cannot read save file: {}", e) })),
            };
            let snap: Snapshot = match serde_json::from_str(&data) {
                Ok(s) => s,
                Err(e) => return warp::reply::json(&serde_json::json!({ "status": "error", "message": format!("Invalid save file: {}", e) })),
            };

            // Restore survival stats
            *player_health_for_load.lock().unwrap() = snap.player_health;
            *total_kills_for_load.lock().unwrap() = snap.score;
            *total_enemy_kills_for_load.lock().unwrap() = 0;
            *total_asteroid_kills_for_load.lock().unwrap() = 0;
            *game_over_timer_for_load.lock().unwrap() = 0.0;

            // Signal game loop to set current_level from save
            *override_level_for_load.lock().unwrap() = Some(snap.current_level);

            // Restore WorldState
            {
                let mut ws = state_for_load.lock().unwrap();
                ws.summary = snap.summary.clone();
                ws.environment_theme = snap.environment_theme.clone();
                ws.terrain_rules = snap.terrain_rules.clone();
                ws.physics_mode = snap.physics_mode.clone();
                ws.camera_zoom = snap.camera_zoom;
                ws.mission_parameters = snap.mission_parameters.clone();
            }

            // Despawn restorable entity types, then re-spawn from snapshot
            const RESTORABLE: &[&str] = &["enemy", "alien_ship", "companion", "space_station"];
            let mut w = world_for_load.lock().unwrap();
            
            // Restore Mission Parameters & Persistent State
            if let Some(params) = snap.mission_parameters {
                w.insert_resource(params);
            }
            w.insert_resource(PersistentWorldState {
                destroyed_ids: snap.persistent_destroyed_ids,
            });

            // Rebuild asteroids based on restored parameters
            rebuild_asteroids(&mut w);

            let to_despawn: Vec<Entity> = {
                let mut q = w.query::<(Entity, &EntityType)>();
                q.iter(&w)
                    .filter(|(_, et)| RESTORABLE.contains(&et.0.as_str()) || et.0 == "projectile" || et.0 == "explosion")
                    .map(|(e, _)| e)
                    .collect()
            };
            for e in to_despawn { w.despawn(e); }

            let mut spawned = 0usize;
            for ent in &snap.entities {
                if !RESTORABLE.contains(&ent.ent_type.as_str()) { continue; }
                let visuals = Visuals {
                    model_type: ent.model_type.clone(),
                    color: ent.color.clone().unwrap_or_else(|| "#ffffff".to_string()),
                    is_cloaked: false,
                };
                let mut eb = w.spawn((
                    EntityType(ent.ent_type.clone()),
                    ent.transform.clone(),
                    ent.physics_type.clone(),
                    visuals,
                    PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
                ));
                if let Some(mv) = ent.model_variant { eb.insert(ModelVariant(mv)); }
                if let Some(sc) = ent.scale { eb.insert(Scale(sc)); }
                // Re-attach AI steering for enemies
                if ent.ent_type == "enemy" || ent.ent_type == "alien_ship" {
                    eb.insert(SteeringAgent { velocity: (0.0, 0.0, 0.0), max_speed: 7.5, max_force: 0.5, behavior: "attack".to_string() });
                    eb.insert(Faction("pirate".to_string()));
                    eb.insert(SpatialAnomaly { anomaly_type: "alien".to_string(), mass: 0.0, radius: 100.0 });
                    eb.insert(WeaponParameters { 
                        projectile_count: 1, 
                        projectile_color: "#ff3333".to_string(), 
                        spread: 0.1, 
                        projectile_size: 6.0,
                        fire_rate_multiplier: 1.0, 
                    });
                }
                spawned += 1;
            }

            println!("[Load] Restored {} entities, level {}, health {:.0}, score {}", spawned, snap.current_level, snap.player_health, snap.score);
            warp::reply::json(&serde_json::json!({ "status": "loaded", "entities": spawned, "level": snap.current_level }))
        });

    // POST /api/command — Interpret AI-orchestrated commands
    let world_for_command = world.clone();
    let command_route = warp::post()
        .and(warp::path("api"))
        .and(warp::path("command"))
        .and(warp::body::json())
        .map(move |req: CommandRequest| {
            let mut w = world_for_command.lock().unwrap();

            if req.action == "set_weapon" {
                // Target: specific entity by id, all entities of a type, or default to player
                let mut target_entities: Vec<Entity> = Vec::new();
                if let Some(id) = req.entity_id {
                    for entity in w.iter_entities() {
                        if entity.id().index() == id {
                            target_entities.push(entity.id());
                            break;
                        }
                    }
                } else {
                    let etype_filter = req.entity_type.as_deref().unwrap_or("player");
                    let mut q = w.query::<(Entity, &EntityType)>();
                    for (e, et) in q.iter(&w) {
                        if et.0 == etype_filter {
                            target_entities.push(e);
                        }
                    }
                }
                let proj_count = req.projectile_count;
                let proj_color = req.projectile_color.clone();
                let spread = req.spread;
                let proj_size = req.projectile_size;
                for e in target_entities {
                    if let Some(mut weapon) = w.get_mut::<WeaponParameters>(e) {
                        if let Some(cnt) = proj_count {
                            weapon.projectile_count = cnt;
                        }
                        if let Some(ref clr) = proj_color {
                            weapon.projectile_color = clr.clone();
                        }
                        if let Some(spr) = spread {
                            weapon.spread = spr;
                        }
                        if let Some(sz) = proj_size {
                            weapon.projectile_size = sz;
                        }
                        if let Some(frm) = req.fire_rate_multiplier {
                            weapon.fire_rate_multiplier = frm;
                        }
                    } else {
                        w.entity_mut(e).insert(WeaponParameters {
                            projectile_count: proj_count.unwrap_or(1),
                            projectile_color: proj_color
                                .clone()
                                .unwrap_or_else(|| "#ef4444".to_string()),
                            spread: spread.unwrap_or(0.1),
                            projectile_size: proj_size.unwrap_or(8.0),
                            fire_rate_multiplier: req.fire_rate_multiplier.unwrap_or(1.0),
                        });
                    }
                }
            } else if req.action == "set_visuals" {
                // AI can set color/model_type/cloaking on any entity by id or type
                let mut target_entities: Vec<Entity> = Vec::new();
                if let Some(id) = req.entity_id {
                    for entity in w.iter_entities() {
                        if entity.id().index() == id {
                            target_entities.push(entity.id());
                            break;
                        }
                    }
                } else {
                    let etype_filter = req.entity_type.as_deref().unwrap_or("player");
                    let mut q = w.query::<(Entity, &EntityType)>();
                    for (e, et) in q.iter(&w) {
                        if et.0 == etype_filter {
                            target_entities.push(e);
                        }
                    }
                }
                let new_model_type = req.model_type.clone();
                let new_color = req.color.clone();
                let new_cloaked = req.is_cloaked;
                for e in target_entities {
                    if let Some(mut vis) = w.get_mut::<Visuals>(e) {
                        if let Some(ref mt) = new_model_type {
                            vis.model_type = Some(mt.clone());
                        }
                        if let Some(ref c) = new_color {
                            vis.color = c.clone();
                        }
                        if let Some(cl) = new_cloaked {
                            vis.is_cloaked = cl;
                        }
                    } else {
                        w.entity_mut(e).insert(Visuals {
                            model_type: new_model_type.clone(),
                            color: new_color.clone().unwrap_or_else(|| "white".to_string()),
                            is_cloaked: new_cloaked.unwrap_or(false),
                        });
                    }
                }
            } else if req.action == "despawn" {
                if let Some(id) = req.entity_id {
                    // Despawn by Index (External targeting often uses index)
                    let mut found = None;
                    for entity in w.iter_entities() {
                        if entity.id().index() == id {
                            found = Some(entity.id());
                            break;
                        }
                    }
                    if let Some(e) = found {
                        w.despawn(e);
                        println!("[Engine] Despawned entity id: {}", id);
                    }
                } else if let Some(etype_target) = req.entity_type {
                    // Despawn all of a certain type (e.g. "asteroid")
                    let mut to_despawn = Vec::new();
                    let mut query = w.query::<(Entity, &EntityType)>();
                    for (entity, etype) in query.iter(&w) {
                        if etype.0 == etype_target {
                            to_despawn.push(entity);
                        }
                    }
                    let count = to_despawn.len();
                    for e in to_despawn {
                        w.despawn(e);
                    }
                    println!(
                        "[Engine] Despawned {} entities of type: {}",
                        count, etype_target
                    );
                }
            }

            warp::reply::json(
                &serde_json::json!({ "status": "command_received", "action": req.action }),
            )
        });

    // POST /api/engine/next-level — Triggered by AI Director to autonomously finish a level
    let force_next_level_route = force_next_level.clone();
    let game_over_timer_for_next = game_over_timer.clone();
    let next_level_route = warp::post()
        .and(warp::path("api"))
        .and(warp::path("engine"))
        .and(warp::path("next-level"))
        .map(move || {
            println!("[Engine] Commander Override received. Advancing to next level.");
            *force_next_level_route.lock().unwrap() = true;
            *game_over_timer_for_next.lock().unwrap() = 0.0;
            warp::reply::json(&serde_json::json!({ "status": "level_advanced_forced" }))
        });

    let world_for_physics = world.clone();
    let physics_route = warp::post()
        .and(warp::path("api"))
        .and(warp::path("physics"))
        .and(warp::body::json())
        .map(move |req: PhysicsUpdateRequest| {
            let mut w = world_for_physics.lock().unwrap();
            if let Some(mut pc) = w.get_resource_mut::<PhysicsConstants>() {
                if let Some(g) = req.gravity_scale {
                    pc.gravity_scale = g;
                }
                if let Some(f) = req.friction {
                    pc.friction = f;
                }
                if let Some(s) = req.projectile_speed_mult {
                    pc.projectile_speed_mult = s;
                }
                println!(
                    "[Engine] Physics Updated -> G: {}, Fric: {}, Proj: {}",
                    pc.gravity_scale, pc.friction, pc.projectile_speed_mult
                );
            }
            warp::reply::json(&serde_json::json!({ "status": "physics_updated" }))
        });

    let world_for_factions = world.clone();
    let factions_route = warp::post()
        .and(warp::path("api"))
        .and(warp::path("factions"))
        .and(warp::body::json())
        .map(move |updates: Vec<FactionPairUpdate>| {
            let mut w = world_for_factions.lock().unwrap();
            if let Some(mut fr) = w.get_resource_mut::<FactionRelations>() {
                for update in &updates {
                    fr.set_affinity(&update.faction_a, &update.faction_b, update.affinity);
                    println!(
                        "[Engine] Faction Relation Updated: {} <-> {} = {}",
                        update.faction_a, update.faction_b, update.affinity
                    );
                }
            }
            warp::reply::json(
                &serde_json::json!({ "status": "factions_updated", "count": updates.len() }),
            )
        });

    // POST /api/pause — freeze physics (tactical map open)
    let is_paused_for_pause = is_paused.clone();
    let pause_route = warp::post()
        .and(warp::path!("api" / "pause"))
        .map(move || {
            *is_paused_for_pause.lock().unwrap() = true;
            warp::reply::json(&serde_json::json!({ "status": "paused" }))
        });

    // POST /api/resume — resume physics (tactical map closed)
    let is_paused_for_resume = is_paused.clone();
    let resume_route = warp::post()
        .and(warp::path!("api" / "resume"))
        .map(move || {
            *is_paused_for_resume.lock().unwrap() = false;
            warp::reply::json(&serde_json::json!({ "status": "resumed" }))
        });

    let routes = get_state_route
        .or(update_state)
        .or(save_route)
        .or(load_route)
        .or(spawn_route)
        .or(clear_route)
        .or(despawn_route)
        .or(modify_route)
        .or(update_player_route)
        .or(command_route)
        .or(next_level_route)
        .or(physics_route)
        .or(factions_route)
        .or(reset_route)
        .or(set_planet_radius_route)
        .or(pause_route)
        .or(resume_route)
        .with(state_cors);
    // Serve state updates + save on 8080
    tokio::spawn(async {
        println!("State API listening on http://127.0.0.1:8080 (endpoints: /state, /save, /api/engine/next-level)");
        warp::serve(routes).run(([127, 0, 0, 1], 8080)).await;
    });

    // Serve Websockets on 8081
    tokio::spawn(async {
        println!("WebSocket Broadcast listening on ws://127.0.0.1:8081/ws");
        let cors = warp::cors()
            .allow_any_origin()
            .allow_headers(vec![
                "User-Agent",
                "Sec-Fetch-Mode",
                "Referer",
                "Origin",
                "Access-Control-Request-Method",
                "Access-Control-Request-Headers",
                "Sec-WebSocket-Key",
                "Sec-WebSocket-Version",
                "Sec-WebSocket-Extensions",
                "Connection",
                "Upgrade",
                "Sec-WebSocket-Protocol",
            ])
            .allow_methods(vec!["GET", "POST", "DELETE", "OPTIONS", "PUT", "PATCH"]);
        warp::serve(ws_route.with(cors))
            .run(([127, 0, 0, 1], 8081))
            .await;
    });
}

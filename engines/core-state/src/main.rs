pub mod api;
mod components;
pub mod engine_state;
pub mod game_loop;
mod systems;
pub mod world;
use crate::world::*;
use bevy_ecs::prelude::*;
use components::{
    AudioSettings, EntityType, FactionRelations, Health, MissionParameters, Name, Parent,
    PersistentWorldState, PhysicsConstants, PhysicsType, SteeringAgent, Transform, Visuals,
    WeaponParameters, WorldState,
};
use futures_util::StreamExt;
use rand::Rng;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
// use warp::Filter;

// Global Entity ID counter for external AI targeting
static GLOBAL_ENTITY_ID: AtomicU64 = AtomicU64::new(1);

type Clients = Arc<Mutex<Vec<mpsc::UnboundedSender<Result<warp::ws::Message, warp::Error>>>>>;

struct PlayerInputState {
    pub up: bool,
    pub down: bool,
    pub left: bool,
    pub right: bool,
    pub shoot: bool,
    pub boost: bool,
    pub cam_yaw: f64,
    pub cam_pitch: f64,
}

#[derive(Resource)]
struct PlayerPhysicsState {
    pub rotational_vel: f64,
}

impl Default for PlayerPhysicsState {
    fn default() -> Self {
        Self {
            rotational_vel: 0.0,
        }
    }
}

impl Default for PlayerInputState {
    fn default() -> Self {
        Self {
            up: false,
            down: false,
            left: false,
            right: false,
            shoot: false,
            boost: false,
            cam_yaw: 0.0,
            cam_pitch: 0.0,
        }
    }
}

// ---------- World Persistence ----------
// ---------- Resources ----------

#[derive(Resource)]
struct SharedState(Arc<Mutex<WorldState>>);

fn sync_state_system(
    shared: Res<SharedState>,
    mut query: Query<(&EntityType, &mut PhysicsType, Option<&mut SteeringAgent>)>,
) {
    let state = shared.0.lock().unwrap();
    let mode = state.physics_mode.as_str();
    let behavior_policy = state.behavior_policy.as_deref();

    for (ent_type, mut phys, mut steering_opt) in query.iter_mut() {
        // 1. Handle Global Behavior Policy (Non-Player)
        if ent_type.0 != "player" {
            if let Some(policy) = behavior_policy {
                if let Some(ref mut steering) = steering_opt {
                    if steering.behavior != policy {
                        steering.behavior = policy.to_string();
                    }
                }
            }
        }

        // 2. Handle Physics Mode (Companion specialized logic)
        if ent_type.0 == "companion" {
            match mode {
                "orbital" => {
                    if let PhysicsType::Orbital { .. } = *phys {
                    } else {
                        *phys = PhysicsType::Orbital {
                            radius: 150.0,
                            speed: 1.5,
                            angle: 0.0,
                        };
                    }
                }
                "sinusoidal" => {
                    if let PhysicsType::Sinusoidal { .. } = *phys {
                    } else {
                        *phys = PhysicsType::Sinusoidal {
                            amplitude: 100.0,
                            frequency: 3.0,
                            time: 0.0,
                        };
                    }
                }
                _ => {
                    *phys = PhysicsType::Static;
                }
            }
        }
    }
}

pub struct RealityModifiers {
    pub gravity: f64,
    pub player_speed: f64,
    pub friction: f64,
}

impl Default for RealityModifiers {
    fn default() -> Self {
        Self {
            gravity: 1.0,
            player_speed: 1.0,
            friction: 0.95,
        }
    }
}

#[tokio::main]
async fn main() {
    println!("Initializing The Void - Rust Core Engine (Phase 4)");

    let initial_state = WorldState {
        summary: "Initializing Solar System...".to_string(),
        environment_theme: "Solar System".to_string(),
        terrain_rules: "Orbital Mechanics Active".to_string(),
        physics_mode: "orbital".to_string(),
        camera_zoom: 1.0,
        player_x: None,
        player_y: None,
        reality_override: None,
        player_spaceship: None,
        behavior_policy: None,
        ship_model: None,
        ship_color: None,
        mission_complete: None,
        radar_filters: [
            ("sun", true),
            ("planet", true),
            ("moon", false),
            ("federation", true),
            ("enemy", true),
            ("station", true),
            ("asteroid", false),
            ("you", true),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), *v))
        .collect(),
        audio_settings: AudioSettings::default(),
        mission_parameters: Some(MissionParameters::default()),
    };

    let state = Arc::new(Mutex::new(initial_state));

    // Shared lerp target: set by /state handler, consumed by the game loop each tick.
    // Option<(f64, f64)> = None means "no override pending".
    let player_target: Arc<Mutex<Option<(f64, f64)>>> = Arc::new(Mutex::new(None));

    let world = Arc::new(Mutex::new(World::new()));
    {
        let mut w = world.lock().unwrap();
        w.insert_resource(SharedState(state.clone()));
        w.insert_resource(MissionParameters::default()); // Pre-populate ECS resource for rebuild_asteroids
        w.insert_resource(PersistentWorldState::default()); // Track destroyed entities

        // Initial Spawn
        rebuild_asteroids(&mut w);
        w.insert_resource(PlayerPhysicsState::default());
        w.insert_resource(PhysicsConstants::default());
        w.insert_resource(FactionRelations::default());

        // --- THE PLAYER ---
        println!(
            "[Engine] Spawning player at ({}, {}, {})",
            8500.0, 500.0, 0.0
        );
        w.spawn((
            EntityType("player".to_string()),
            Transform {
                x: 8500.0,
                y: 500.0,
                z: 0.0,
                rotation: 0.0,
            }, // Start near Earth
            PhysicsType::Velocity {
                vx: 0.0,
                vy: 0.0,
                vz: 0.0,
            },
            Health {
                max: 100.0,
                current: 100.0,
            },
            Visuals {
                model_type: Some("ufo".to_string()),
                color: "cyan".to_string(),
                is_cloaked: false,
            },
            WeaponParameters {
                projectile_count: 1,
                projectile_color: "#ef4444".to_string(),
                spread: 0.15,
                projectile_size: 8.0,
            },
            components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
        ));

        // --- THE SOLAR SYSTEM GENESIS ---
        // 1. THE SUN: Massive gravity well at the center
        w.spawn((
            EntityType("sun".to_string()),
            Name("Sun".to_string()),
            Transform {
                x: 0.0,
                y: 0.0,
                z: 0.0,
                rotation: 0.0,
            },
            PhysicsType::Static,
            components::SpatialAnomaly {
                anomaly_type: "sun".to_string(),
                mass: 50000.0,
                radius: 1500.0, // Increased Sun Physical Radius (1.5x)
            },
            components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
        ));

        // 2. THE PLANETS: Refactored for X-Z Plane and Hardcoded Distances
        let planet_configs = vec![
            // (name, orbital_radius, Keplerian_speed_rad_s, collision_radius)
            // Keplerian: ω = 0.40 × (8000/r)^(3/2), sizes ×3
            ("Mercury", 3500.0, 1.38, 120.0),
            ("Venus", 5500.0, 0.70, 255.0),
            ("Earth", 8000.0, 0.40, 300.0),
            ("Mars", 11000.0, 0.25, 180.0),
            ("Jupiter", 17000.0, 0.13, 750.0),
            ("Saturn", 23000.0, 0.082, 630.0),
            ("Uranus", 27000.0, 0.064, 420.0),
            ("Neptune", 30000.0, 0.055, 390.0),
        ];

        for (name, dist, speed, size) in planet_configs {
            let angle = if name == "Earth" {
                0.0
            } else {
                rand::thread_rng().gen_range(0.0..std::f64::consts::TAU)
            };
            let planet_id = w
                .spawn((
                    EntityType("planet".to_string()),
                    Name(name.to_string()),
                    Transform {
                        x: angle.cos() * dist,
                        y: rand::thread_rng().gen_range(-300.0..300.0), // Orbital Inclination
                        z: angle.sin() * dist,
                        rotation: 0.0,
                    },
                    PhysicsType::Orbital {
                        radius: dist,
                        speed,
                        angle,
                    },
                    components::SpatialAnomaly {
                        anomaly_type: "planet".to_string(),
                        mass: 0.0,
                        radius: size,
                    },
                    components::Scale(1.0),
                    components::ModelVariant(0),
                    components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
                ))
                .id()
                .index();

            // --- MOON SPAWNING (×5 of 4× rescaled values + Keplerian speeds) ---
            // orbital_r = 5× pre-×3 values; visual_r = 5× pre-×3 values; speeds Keplerian-adjusted
            match name {
                "Earth" => {
                    w.spawn((
                        EntityType("moon".to_string()),
                        Name("Luna".to_string()),
                        Transform {
                            x: 1750.0,
                            y: 0.0,
                            z: 0.0,
                            rotation: 0.0,
                        },
                        PhysicsType::Orbital {
                            radius: 1750.0,
                            speed: 0.091,
                            angle: 0.0,
                        },
                        components::SpatialAnomaly {
                            anomaly_type: "moon".to_string(),
                            mass: 0.0,
                            radius: 80.0,
                        },
                        Parent(planet_id),
                        Visuals {
                            model_type: Some("sphere".to_string()),
                            color: "#a8a8a8".to_string(),
                            is_cloaked: false,
                        },
                    ));
                }
                "Mars" => {
                    w.spawn((
                        EntityType("moon".to_string()),
                        Name("Phobos".to_string()),
                        Transform {
                            x: 1100.0,
                            y: 0.0,
                            z: 0.0,
                            rotation: 0.0,
                        },
                        PhysicsType::Orbital {
                            radius: 1100.0,
                            speed: 0.191,
                            angle: 0.5,
                        },
                        components::SpatialAnomaly {
                            anomaly_type: "moon".to_string(),
                            mass: 0.0,
                            radius: 25.0,
                        },
                        Parent(planet_id),
                        Visuals {
                            model_type: Some("asteroid".to_string()),
                            color: "#5c534b".to_string(),
                            is_cloaked: false,
                        },
                    ));
                    w.spawn((
                        EntityType("moon".to_string()),
                        Name("Deimos".to_string()),
                        Transform {
                            x: 1500.0,
                            y: 0.0,
                            z: 0.0,
                            rotation: 0.0,
                        },
                        PhysicsType::Orbital {
                            radius: 1500.0,
                            speed: 0.121,
                            angle: 2.1,
                        },
                        components::SpatialAnomaly {
                            anomaly_type: "moon".to_string(),
                            mass: 0.0,
                            radius: 18.0,
                        },
                        Parent(planet_id),
                        Visuals {
                            model_type: Some("asteroid".to_string()),
                            color: "#8c7e71".to_string(),
                            is_cloaked: false,
                        },
                    ));
                }
                "Jupiter" => {
                    w.spawn((
                        EntityType("moon".to_string()),
                        Name("Io".to_string()),
                        Transform {
                            x: 3250.0,
                            y: 0.0,
                            z: 0.0,
                            rotation: 0.0,
                        },
                        PhysicsType::Orbital {
                            radius: 3250.0,
                            speed: 0.155,
                            angle: 0.0,
                        },
                        components::SpatialAnomaly {
                            anomaly_type: "moon".to_string(),
                            mass: 0.0,
                            radius: 200.0,
                        },
                        Parent(planet_id),
                        Visuals {
                            model_type: Some("sphere".to_string()),
                            color: "#e6c13e".to_string(),
                            is_cloaked: false,
                        },
                    ));
                    w.spawn((
                        EntityType("moon".to_string()),
                        Name("Europa".to_string()),
                        Transform {
                            x: 4000.0,
                            y: 0.0,
                            z: 0.0,
                            rotation: 0.0,
                        },
                        PhysicsType::Orbital {
                            radius: 4000.0,
                            speed: 0.122,
                            angle: 1.2,
                        },
                        components::SpatialAnomaly {
                            anomaly_type: "moon".to_string(),
                            mass: 0.0,
                            radius: 180.0,
                        },
                        Parent(planet_id),
                        Visuals {
                            model_type: Some("sphere".to_string()),
                            color: "#c2b19f".to_string(),
                            is_cloaked: false,
                        },
                    ));
                }
                "Saturn" => {
                    w.spawn((
                        EntityType("moon".to_string()),
                        Name("Titan".to_string()),
                        Transform {
                            x: 4500.0,
                            y: 0.0,
                            z: 0.0,
                            rotation: 0.0,
                        },
                        PhysicsType::Orbital {
                            radius: 4500.0,
                            speed: 0.050,
                            angle: 3.1,
                        },
                        components::SpatialAnomaly {
                            anomaly_type: "moon".to_string(),
                            mass: 0.0,
                            radius: 250.0,
                        },
                        Parent(planet_id),
                        Visuals {
                            model_type: Some("sphere".to_string()),
                            color: "#d19b45".to_string(),
                            is_cloaked: false,
                        },
                    ));
                }
                _ => {}
            }
        }

        // 3. GLOBAL ASTEROID DISTRIBUTION — Handled by rebuild_asteroids() above.

        // 4. NEW ENTITY TYPES: SpaceStations & AlienShips
        let mut rng = rand::thread_rng();
        for i in 0..5 {
            let r = 5000.0 + (30000.0 - 5000.0) * rng.gen::<f64>().sqrt();
            let angle = rng.gen_range(0.0..std::f64::consts::TAU);
            w.spawn((
                EntityType("space_station".to_string()),
                Name(format!("Station-{}", i)),
                Transform {
                    x: angle.cos() * r,
                    y: rng.gen_range(-2000.0..2000.0),
                    z: angle.sin() * r,
                    rotation: 0.0,
                },
                PhysicsType::Static,
                components::SpatialAnomaly {
                    anomaly_type: "station".to_string(),
                    mass: 1000.0,
                    radius: 400.0,
                },
                components::Scale(1.0),
                components::ModelVariant(0),
                Visuals {
                    model_type: Some("station".to_string()),
                    color: "#ffffff".to_string(),
                    is_cloaked: false,
                },
                components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
            ));
        }

        // 5. GATEWAY CORE — permanent named station near Lunar orbit (Earth ~8000, Luna ~+3800)
        // ModelVariant(5) maps to gateway.glb in the frontend STATION_MODELS array.
        w.spawn((
            EntityType("space_station".to_string()),
            Name("Gateway Core".to_string()),
            Transform {
                x: 12000.0,
                y: 300.0,
                z: 600.0,
                rotation: 0.0,
            },
            PhysicsType::Static,
            components::SpatialAnomaly {
                anomaly_type: "station".to_string(),
                mass: 5000.0,
                radius: 800.0,
            },
            components::Scale(1.0),
            components::ModelVariant(5),
            Visuals {
                model_type: Some("station".to_string()),
                color: "#38bdf8".to_string(),
                is_cloaked: false,
            },
            components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
        ));

        for i in 0..12 {
            let r = 3000.0 + (28000.0 - 3000.0) * rng.gen::<f64>().sqrt();
            let angle = rng.gen_range(0.0..std::f64::consts::TAU);
            w.spawn((
                EntityType("enemy".to_string()),
                Name(format!("Alien-{}", i)),
                Transform {
                    x: angle.cos() * r,
                    y: rng.gen_range(-2000.0..2000.0),
                    z: angle.sin() * r,
                    rotation: 0.0,
                },
                PhysicsType::Velocity {
                    vx: 0.0,
                    vy: 0.0,
                    vz: 0.0,
                },
                components::SteeringAgent {
                    velocity: (0.0, 0.0, 0.0),
                    max_speed: 7.5, // halved from 15.0
                    max_force: 0.5,
                    behavior: "wander".to_string(),
                },
                components::Faction("pirate".to_string()),
                components::SpatialAnomaly {
                    anomaly_type: "alien".to_string(),
                    mass: 0.0,
                    radius: 100.0,
                },
                components::Scale(2.4), // doubled from 1.2
                components::ModelVariant(rng.gen_range(0..2)),
                Visuals {
                    model_type: Some("enemy".to_string()),
                    color: "rgba(239, 68, 68, 0.85)".to_string(),
                    is_cloaked: false,
                },
                components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
                WeaponParameters {
                    projectile_count: 1,
                    projectile_color: "#ff3333".to_string(),
                    spread: 0.1,
                    projectile_size: 6.0,
                },
            ));
        }
        println!("Solar System initialized with Sun, 8 planets, and scattered asteroids.");
    } // drop the lock held during init

    let clients: Clients = Arc::new(Mutex::new(Vec::new()));
    let player_input_state = Arc::new(Mutex::new(PlayerInputState::default()));
    let reality_modifiers: Arc<Mutex<RealityModifiers>> =
        Arc::new(Mutex::new(RealityModifiers::default()));

    let player_health: Arc<Mutex<f64>> = Arc::new(Mutex::new(100.0));
    let damage_cooldown: Arc<Mutex<f64>> = Arc::new(Mutex::new(0.0));
    let player_knockback: Arc<Mutex<(f64, f64)>> = Arc::new(Mutex::new((0.0, 0.0)));
    let total_kills: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
    let total_enemy_kills: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
    let total_asteroid_kills: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
    let level_start_time: Arc<Mutex<std::time::Instant>> =
        Arc::new(Mutex::new(std::time::Instant::now()));
    let game_over_timer: Arc<Mutex<f64>> = Arc::new(Mutex::new(0.0));
    let do_full_reset: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
    let override_level: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
    let current_level_shared: Arc<Mutex<u32>> = Arc::new(Mutex::new(1));
    let force_next_level: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
    let is_paused: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));

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
        is_paused: is_paused.clone(),
    };

    crate::api::start_api_server(engine_state.clone()).await;
    game_loop::run(engine_state).await;
}

mod components;
mod systems;

use bevy_ecs::prelude::*;
use warp::Filter;
use std::sync::{Arc, Mutex};
use components::{WorldState, Transform, EntityType, Name, PhysicsType, BirthAge, DeathAge, SteeringAgent, SpatialAnomaly, Particle, Projectile, PlayerInputMessage, Health, Faction, Visuals, UpdatePlayerRequest, Parent, SpawnAge, WeaponParameters, CommandRequest, TargetLock, PersistentId, ModelVariant, Scale, PhysicsConstants, FactionRelations};
use serde::{Serialize, Deserialize};
use futures_util::StreamExt;
use tokio::sync::mpsc;
use rand::Rng;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use systems::MAX_WORLD_RADIUS;

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
        Self { rotational_vel: 0.0 }
    }
}

impl Default for PlayerInputState {
    fn default() -> Self {
        Self { up: false, down: false, left: false, right: false, shoot: false, boost: false, cam_yaw: 0.0, cam_pitch: 0.0 }
    }
}

#[derive(Serialize)]
struct EntityData {
    id: u32,
    x: f64,
    y: f64,
    z: f64,
    rotation: f64,
    speed: f64,
    ent_type: String,
    color: String,
    is_newborn: bool,
    is_dying: bool,
    behavior: String,
    faction: String,
    name: Option<String>,
    radius: Option<f64>,
    anomaly_type: Option<String>,
    anomaly_radius: Option<f64>,
    model_type: Option<String>,
    custom_color: Option<String>,
    parent_id: Option<u32>,
    spawn_age: Option<f64>,
    persistent_id: Option<u64>,
    target_lock_id: Option<u32>,
    is_cloaked: bool,
    scale: Option<f64>,
    model_variant: Option<u32>,
    projectile_size: Option<f64>,
    health_current: Option<f64>,
    health_max: Option<f64>,
}

#[derive(Deserialize, Debug)]
struct SpawnEntityRequest {
    ent_type: String,
    x: f64,
    y: f64,
    physics: String,
    faction: Option<String>,
    radius: Option<f64>,
    speed: Option<f64>,
    amplitude: Option<f64>,
    frequency: Option<f64>,
    anomaly_type: Option<String>,
    mass: Option<f64>,
}

#[derive(Deserialize, Debug)]
struct DespawnRequest {
    ent_type: Option<String>,
    color: Option<String>,
    ids: Option<Vec<u32>>,
}

#[derive(Deserialize, Debug)]
struct ModifyRequest {
    id: u32,
    physics: Option<String>,
    color: Option<String>,
    radius: Option<f64>,
    speed: Option<f64>,
    amplitude: Option<f64>,
    frequency: Option<f64>,
    behavior: Option<String>,
}

/// Request body for POST /api/physics
#[derive(Deserialize, Debug)]
struct PhysicsUpdateRequest {
    gravity_scale: Option<f64>,
    friction: Option<f64>,
    projectile_speed_mult: Option<f64>,
}

/// Single faction-pair affinity update for POST /api/factions
#[derive(Deserialize, Debug)]
struct FactionPairUpdate {
    faction_a: String,
    faction_b: String,
    affinity: f64,
}

#[derive(Serialize)]
struct CollisionEvent {
    #[serde(rename = "type")]
    msg_type: String,
    star_id: u32,
    speed: f64,
    distance: f64,
}

#[derive(Serialize)]
struct SpatialGrid {
    size: f64,
    divisions: u32,
}

#[derive(Serialize)]
struct ParticleData {
    x: f64,
    y: f64,
    z: f64,
    lifespan: f64,
    max_lifespan: f64,
    color: String,
}

#[derive(Serialize)]
struct RenderFrameState {
    #[serde(rename = "type")]
    msg_type: String,
    environment_theme: String,
    terrain_rules: String,
    grid: SpatialGrid,
    entities: Vec<EntityData>,
    particles: Vec<ParticleData>,
    player_health: f64,
    score: u32,
    current_level: u32,
    is_game_over: bool,
    objective: String,
    kills_in_level: u32,
    success_kill: bool,
}

// ---------- Helpers for Level Progression ----------
fn spawn_wave(w: &mut World, count: usize, faction: &str, ent_type: &str, dist_range: (f64, f64), variant: u32) {
    let mut rng = rand::thread_rng();
    for _ in 0..count {
        let radius = rng.gen_range(dist_range.0..dist_range.1);
        let angle = rng.gen_range(0.0..std::f64::consts::TAU);
        let speed = rng.gen_range(20.0..60.0);

        // Per-tier weapon and visual parameters
        let (proj_color, proj_size, proj_count, proj_spread) = match variant {
            2 => ("#aa44ff".to_string(), 16.0_f64, 3_u32, 0.35_f64), // Mothership: violet bursts
            1 => ("#00ff88".to_string(), 10.0_f64, 2_u32, 0.20_f64), // Ravager: twin green bolts
            _ => ("#ff3333".to_string(),  6.0_f64, 1_u32, 0.10_f64), // Swarmer: single red shot
        };

        let mut ent_mut = w.spawn((
            components::EntityType(ent_type.to_string()),
            components::Transform { x: angle.cos() * radius, y: rng.gen_range(-200.0..200.0), z: angle.sin() * radius, rotation: angle },
            components::PhysicsType::Orbital { radius, speed: rng.gen_range(0.5..1.5), angle },
            components::BirthAge(0.0),
            components::Faction(faction.to_string()),
            components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
            components::Visuals {
                model_type: None,
                color: if variant == 2 { "#a855f7" } else if variant == 1 { "#10b981" } else { "#ef4444" }.to_string(),
                is_cloaked: false,
            },
            components::ModelVariant(variant),
            components::Scale(if variant == 2 { 6.0 } else if variant == 1 { 3.0 } else { 2.0 }), // 2× larger
            Health {
                max: if variant == 2 { 500.0 } else if variant == 1 { 150.0 } else { 40.0 },
                current: if variant == 2 { 500.0 } else if variant == 1 { 150.0 } else { 40.0 },
            },
        ));

        if ent_type == "enemy" || ent_type == "companion" {
            ent_mut.insert(components::SteeringAgent {
                behavior: "attack".to_string(),
                velocity: (0.0, 0.0, 0.0),
                max_speed: speed * 0.5 * (if variant == 2 { 0.5 } else { 1.0 }), // half speed
                max_force: 2.0,
            });
            ent_mut.insert(WeaponParameters {
                projectile_count: proj_count,
                projectile_color: proj_color,
                spread: proj_spread,
                projectile_size: proj_size,
            });
        }
    }
}

fn spawn_anomaly(w: &mut World, anomaly_type: &str, mass: f64, radius: f64, dist: f64) {
    let mut rng = rand::thread_rng();
    let angle = rng.gen_range(0.0..std::f64::consts::TAU);
    w.spawn((
        components::EntityType("anomaly".to_string()),
        components::Transform { x: angle.cos() * dist, y: angle.sin() * dist, z: 0.0, rotation: 0.0 },
        components::PhysicsType::Static,
        components::SpatialAnomaly {
            anomaly_type: anomaly_type.to_string(),
            mass,
            radius,
        },
        components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
    ));
}

// ---------- World Persistence ----------

#[derive(Serialize, Deserialize, Debug, Clone)]
struct SnapshotEntity {
    ent_type: String,
    transform: components::Transform,
    physics_type: components::PhysicsType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_variant: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_type: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Snapshot {
    summary: String,
    environment_theme: String,
    terrain_rules: String,
    physics_mode: String,
    camera_zoom: f64,
    player_health: f64,
    score: u32,
    current_level: u32,
    entities: Vec<SnapshotEntity>,
}

/// Captures restorable entities (enemies, companions, alien_ships) + WorldState + player stats
/// and writes world_snap.json next to the project root.
fn save_world_to_disk(
    world: &mut World,
    state: &Arc<Mutex<WorldState>>,
    player_health: f64,
    score: u32,
    current_level: u32,
) -> Result<(), String> {
    let ws = state.lock().map_err(|e| format!("Lock error: {}", e))?;

    const SAVEABLE: &[&str] = &["enemy", "alien_ship", "companion", "space_station"];

    let mut entities = Vec::new();
    let mut query = world.query::<(&EntityType, &Transform, &PhysicsType, Option<&components::ModelVariant>, Option<&components::Scale>, Option<&Visuals>)>();
    for (ent_type, transform, phys, variant_opt, scale_opt, visuals_opt) in query.iter(world) {
        if !SAVEABLE.contains(&ent_type.0.as_str()) {
            continue;
        }
        entities.push(SnapshotEntity {
            ent_type: ent_type.0.clone(),
            transform: transform.clone(),
            physics_type: phys.clone(),
            model_variant: variant_opt.map(|m| m.0),
            scale: scale_opt.map(|s| s.0),
            color: visuals_opt.map(|v| v.color.clone()),
            model_type: visuals_opt.and_then(|v| v.model_type.clone()),
        });
    }

    let snapshot = Snapshot {
        summary: ws.summary.clone(),
        environment_theme: ws.environment_theme.clone(),
        terrain_rules: ws.terrain_rules.clone(),
        physics_mode: ws.physics_mode.clone(),
        camera_zoom: ws.camera_zoom,
        player_health,
        score,
        current_level,
        entities,
    };

    let json = serde_json::to_string_pretty(&snapshot)
        .map_err(|e| format!("Serialize error: {}", e))?;

    // Write next to the project root
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("world_snap.json"))
        .unwrap_or_else(|| std::path::PathBuf::from("world_snap.json"));

    let mut file = std::fs::File::create(&path)
        .map_err(|e| format!("File create error: {}", e))?;
    file.write_all(json.as_bytes())
        .map_err(|e| format!("File write error: {}", e))?;

    println!("World snapshot saved to {:?} ({} entities)", path, snapshot.entities.len());
    Ok(())
}

// ---------- Resources ----------

#[derive(Resource)]
struct SharedState(Arc<Mutex<WorldState>>);

fn sync_state_system(
    shared: Res<SharedState>,
    mut query: Query<(&EntityType, &mut PhysicsType, Option<&mut SteeringAgent>)>
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
                    if let PhysicsType::Orbital { .. } = *phys {} else {
                        *phys = PhysicsType::Orbital { radius: 150.0, speed: 1.5, angle: 0.0 };
                    }
                }
                "sinusoidal" => {
                    if let PhysicsType::Sinusoidal { .. } = *phys {} else {
                        *phys = PhysicsType::Sinusoidal { amplitude: 100.0, frequency: 3.0, time: 0.0 };
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
        Self { gravity: 1.0, player_speed: 1.0, friction: 0.95 }
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
    };

    let state = Arc::new(Mutex::new(initial_state));

    // Shared lerp target: set by /state handler, consumed by the game loop each tick.
    // Option<(f64, f64)> = None means "no override pending".
    let player_target: Arc<Mutex<Option<(f64, f64)>>> = Arc::new(Mutex::new(None));

    let world = Arc::new(Mutex::new(World::new()));
    {
        let mut w = world.lock().unwrap();
        w.insert_resource(SharedState(state.clone()));
        w.insert_resource(PlayerPhysicsState::default());
        w.insert_resource(PhysicsConstants::default());
        w.insert_resource(FactionRelations::default());

        // --- THE PLAYER ---
        println!("[Engine] Spawning player at ({}, {}, {})", 8500.0, 500.0, 0.0);
        w.spawn((
            EntityType("player".to_string()),
            Transform { x: 8500.0, y: 500.0, z: 0.0, rotation: 0.0 }, // Start near Earth
            PhysicsType::Velocity { vx: 0.0, vy: 0.0, vz: 0.0 },
            Health { max: 100.0, current: 100.0 },
            Visuals { model_type: Some("ufo".to_string()), color: "cyan".to_string(), is_cloaked: false },
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
            Transform { x: 0.0, y: 0.0, z: 0.0, rotation: 0.0 },
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
            ("Mercury", 3500.0,  0.8, 80.0),   // 2x
            ("Venus",   5500.0,  0.6, 170.0),  // 2x
            ("Earth",   8000.0,  0.4, 200.0),  // 2x
            ("Mars",    11000.0, 0.35, 120.0), // 2x
            ("Jupiter", 17000.0, 0.2, 500.0),  // 2x
            ("Saturn",  23000.0, 0.15, 420.0), // 2x
            ("Uranus",  27000.0, 0.1, 280.0),  // 2x
            ("Neptune", 30000.0, 0.08, 260.0), // 2x
        ];

        for (name, dist, speed, size) in planet_configs {
            let angle = if name == "Earth" { 0.0 } else { rand::thread_rng().gen_range(0.0..std::f64::consts::TAU) };
            let planet_id = w.spawn((
                EntityType("planet".to_string()),
                Name(name.to_string()),
                Transform { 
                    x: angle.cos() * dist, 
                    y: rand::thread_rng().gen_range(-300.0..300.0), // Orbital Inclination
                    z: angle.sin() * dist, 
                    rotation: 0.0 
                },
                PhysicsType::Orbital { radius: dist, speed, angle },
                components::SpatialAnomaly {
                    anomaly_type: "planet".to_string(),
                    mass: 0.0,
                    radius: size, 
                },
                components::Scale(1.0),
                components::ModelVariant(0),
                components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
            )).id().index();

            // --- MOON SPANNING (4x Rescaled) ---
            match name {
                "Earth" => {
                    w.spawn((
                        EntityType("moon".to_string()),
                        Name("Luna".to_string()),
                        Transform { x: 350.0, y: 0.0, z: 0.0, rotation: 0.0 }, // Increased offset
                        PhysicsType::Orbital { radius: 350.0, speed: 1.02, angle: 0.0 },
                        components::SpatialAnomaly { anomaly_type: "moon".to_string(), mass: 0.0, radius: 100.0 }, // 4x (25 -> 100)
                        Parent(planet_id),
                        Visuals { model_type: Some("sphere".to_string()), color: "#a8a8a8".to_string(), is_cloaked: false }
                    ));
                },
                "Mars" => {
                    w.spawn((EntityType("moon".to_string()), Name("Phobos".to_string()), Transform { x: 220.0, y: 0.0, z: 0.0, rotation: 0.0 }, PhysicsType::Orbital { radius: 220.0, speed: 2.14, angle: 0.5 }, components::SpatialAnomaly { anomaly_type: "moon".to_string(), mass: 0.0, radius: 60.0 }, Parent(planet_id), Visuals { model_type: Some("asteroid".to_string()), color: "#5c534b".to_string(), is_cloaked: false })); // 4x (15 -> 60)
                    w.spawn((EntityType("moon".to_string()), Name("Deimos".to_string()), Transform { x: 300.0, y: 0.0, z: 0.0, rotation: 0.0 }, PhysicsType::Orbital { radius: 300.0, speed: 1.35, angle: 2.1 }, components::SpatialAnomaly { anomaly_type: "moon".to_string(), mass: 0.0, radius: 48.0 }, Parent(planet_id), Visuals { model_type: Some("asteroid".to_string()), color: "#8c7e71".to_string(), is_cloaked: false })); // 4x (12 -> 48)
                },
                "Jupiter" => {
                    w.spawn((EntityType("moon".to_string()), Name("Io".to_string()), Transform { x: 650.0, y: 0.0, z: 0.0, rotation: 0.0 }, PhysicsType::Orbital { radius: 650.0, speed: 1.73, angle: 0.0 }, components::SpatialAnomaly { anomaly_type: "moon".to_string(), mass: 0.0, radius: 140.0 }, Parent(planet_id), Visuals { model_type: Some("sphere".to_string()), color: "#e6c13e".to_string(), is_cloaked: false })); // 4x (35 -> 140)
                    w.spawn((EntityType("moon".to_string()), Name("Europa".to_string()), Transform { x: 800.0, y: 0.0, z: 0.0, rotation: 0.0 }, PhysicsType::Orbital { radius: 800.0, speed: 1.37, angle: 1.2 }, components::SpatialAnomaly { anomaly_type: "moon".to_string(), mass: 0.0, radius: 120.0 }, Parent(planet_id), Visuals { model_type: Some("sphere".to_string()), color: "#c2b19f".to_string(), is_cloaked: false })); // 4x (30 -> 120)
                },
                "Saturn" => {
                    w.spawn((EntityType("moon".to_string()), Name("Titan".to_string()), Transform { x: 900.0, y: 0.0, z: 0.0, rotation: 0.0 }, PhysicsType::Orbital { radius: 900.0, speed: 0.56, angle: 3.1 }, components::SpatialAnomaly { anomaly_type: "moon".to_string(), mass: 0.0, radius: 240.0 }, Parent(planet_id), Visuals { model_type: Some("sphere".to_string()), color: "#d19b45".to_string(), is_cloaked: false })); // 4x (60 -> 240)
                },
                _ => {}
            }
        }

        // 3. GLOBAL ASTEROID DISTRIBUTION — 3000 spread between 3k–32k.
        // Only nearby asteroids are sent per frame (distance culling), so the total count
        // doesn't affect network throughput. 
        let mut rng = rand::thread_rng();
        for _ in 0..3000 {
            // Non-clumping polar distribution using sqrt()
            let r = 3000.0 + (32000.0 - 3000.0) * rng.gen::<f64>().sqrt();
            let theta = rng.gen_range(0.0..std::f64::consts::TAU);
            let x = r * theta.cos();
            let z = r * theta.sin();
            let y = rng.gen_range(-8000.0..8000.0); // Expanded Y depth
            let scale_val = rng.gen_range(0.5..2.5);
            let variant = rng.gen_range(0..5);
            w.spawn((
                EntityType("asteroid".to_string()),
                Transform { x, y, z, rotation: rng.gen_range(0.0..std::f64::consts::TAU) },
                // No PhysicsType — asteroids are truly static and skipping them from ECS
                // physics queries gives a huge performance boost (5000 fewer iterations/tick).
                components::SpatialAnomaly { anomaly_type: "asteroid".to_string(), mass: 0.0, radius: rng.gen_range(5.0..40.0) },
                components::Scale(scale_val),
                components::ModelVariant(variant),
                components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
            ));
        }

        // 4. NEW ENTITY TYPES: SpaceStations & AlienShips
        for i in 0..5 {
            let r = 5000.0 + (30000.0 - 5000.0) * rng.gen::<f64>().sqrt();
            let angle = rng.gen_range(0.0..std::f64::consts::TAU);
            w.spawn((
                EntityType("space_station".to_string()),
                Name(format!("Station-{}", i)),
                Transform { x: angle.cos() * r, y: rng.gen_range(-2000.0..2000.0), z: angle.sin() * r, rotation: 0.0 },
                PhysicsType::Static,
                components::SpatialAnomaly { anomaly_type: "station".to_string(), mass: 1000.0, radius: 400.0 },
                components::Scale(1.0),
                components::ModelVariant(0),
                Visuals { model_type: Some("station".to_string()), color: "#ffffff".to_string(), is_cloaked: false },
                components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
            ));
        }

        for i in 0..12 {
            let r = 3000.0 + (28000.0 - 3000.0) * rng.gen::<f64>().sqrt();
            let angle = rng.gen_range(0.0..std::f64::consts::TAU);
            w.spawn((
                EntityType("enemy".to_string()),
                Name(format!("Alien-{}", i)),
                Transform { x: angle.cos() * r, y: rng.gen_range(-2000.0..2000.0), z: angle.sin() * r, rotation: 0.0 },
                PhysicsType::Velocity { vx: 0.0, vy: 0.0, vz: 0.0 },
                components::SteeringAgent {
                    velocity: (0.0, 0.0, 0.0),
                    max_speed: 7.5, // halved from 15.0
                    max_force: 0.5,
                    behavior: "wander".to_string(),
                },
                components::Faction("pirate".to_string()),
                components::SpatialAnomaly { anomaly_type: "alien".to_string(), mass: 0.0, radius: 100.0 },
                components::Scale(2.4), // doubled from 1.2
                components::ModelVariant(rng.gen_range(0..2)),
                Visuals { model_type: Some("enemy".to_string()), color: "rgba(239, 68, 68, 0.85)".to_string(), is_cloaked: false },
                components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
                WeaponParameters { projectile_count: 1, projectile_color: "#ff3333".to_string(), spread: 0.1, projectile_size: 6.0 },
            ));
        }
        println!("Solar System initialized with Sun, 8 planets, and scattered asteroids.");

    } // drop the lock held during init

    let mut schedule = Schedule::default();
    schedule.add_systems((
        sync_state_system,
        systems::generative_physics_system,
        systems::environmental_physics_system,
        systems::particle_physics_system,
        systems::steering_system,
        // We will do projectile logic in the main loop to keep it simple along with collision.
    ));
    let state_for_routes = state.clone();
    let state_filter = warp::any().map(move || state_for_routes.clone());

    let clients: Clients = Arc::new(Mutex::new(Vec::new()));
    let clients_for_state = clients.clone();
    let player_target_for_state = player_target.clone();

    let player_input_state = Arc::new(Mutex::new(PlayerInputState::default()));

    let reality_modifiers: Arc<Mutex<RealityModifiers>> = Arc::new(Mutex::new(RealityModifiers::default()));
    let reality_for_sys = reality_modifiers.clone();
    let reality_for_state = reality_modifiers.clone();

    // ---------- Survival State (declared before routes so handlers can access them) ----------
    let player_health: Arc<Mutex<f64>> = Arc::new(Mutex::new(100.0));
    let damage_cooldown: Arc<Mutex<f64>> = Arc::new(Mutex::new(0.0));
    let player_knockback: Arc<Mutex<(f64, f64)>> = Arc::new(Mutex::new((0.0, 0.0)));
    let total_kills: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
    let total_enemy_kills: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
    let total_asteroid_kills: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
    let level_start_time: Arc<Mutex<std::time::Instant>> = Arc::new(Mutex::new(std::time::Instant::now()));
    let game_over_timer: Arc<Mutex<f64>> = Arc::new(Mutex::new(0.0));
    // Signal: HTTP route sets true → game loop resets level + entities
    let do_full_reset: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
    // Signal: HTTP route sets Some(n) → game loop resets current_level to n
    let override_level: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
    // Shared current level for save route to read
    let current_level_shared: Arc<Mutex<u32>> = Arc::new(Mutex::new(1));

    let update_state = warp::post()
        .and(warp::path("state"))
        .and(warp::body::json())
        .and(state_filter.clone())
        .and(warp::any().map(move || clients_for_state.clone()))
        .and(warp::any().map(move || player_target_for_state.clone()))
        .and(warp::any().map(move || reality_for_state.clone()))
        .map(|new_state: WorldState, state: Arc<Mutex<WorldState>>, _clients: Clients, pt: Arc<Mutex<Option<(f64, f64)>>>, rm: Arc<Mutex<RealityModifiers>>| {
            println!("Received new WorldState: {:?}", new_state.summary);
            
            let mut current_state = state.lock().unwrap();
            
            // High-Priority Player Override: stage lerp target if coordinates arrived.
            // Option Safety: None means this was a zoom-only update — player untouched.
            if let (Some(px), Some(py)) = (new_state.player_x, new_state.player_y) {
                println!("[Director Override] Player target set to ({}, {})", px, py);
                *pt.lock().unwrap() = Some((px, py));
            }

            if let Some(ro) = &new_state.reality_override {
                let mut modifiers = rm.lock().unwrap();
                if let Some(g) = ro.gravity_multiplier { modifiers.gravity = g; }
                if let Some(ps) = ro.player_speed_multiplier { modifiers.player_speed = ps; }
                if let Some(f) = ro.global_friction { modifiers.friction = f; }
                println!("[Director] Reality Override Applied -> G: {}, PS: {}, Fric: {}", modifiers.gravity, modifiers.player_speed, modifiers.friction);
            }

            *current_state = new_state.clone();

            warp::reply::json(&*current_state)
        });

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
    let save_route = warp::post()
        .and(warp::path("save"))
        .map(move || {
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
                        let derived_radius = req.radius.unwrap_or_else(|| {
                            (req.x * req.x + req.y * req.y).sqrt().max(150.0)
                        });
                        // Preserve the initial angle so the entity spawns in the right quadrant
                        let derived_angle = req.y.atan2(req.x);
                        PhysicsType::Orbital {
                            radius: derived_radius,
                            speed: req.speed.unwrap_or(1.5),
                            angle: derived_angle,
                        }
                    },
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
                    Transform { x: req.x, y: req.y, z: 0.0, rotation: 0.0 },
                    phys_type,
                    BirthAge(0.0), // Starts the 2-second glow/acceleration effect
                    Faction(faction_str.clone()),
                ));
                // Add SteeringAgent for enemy/companion types so they can participate in faction combat
                if req.ent_type == "enemy" || req.ent_type == "companion" {
                    ent_mut.insert(SteeringAgent {
                        behavior: "idle".to_string(),
                        velocity: (0.0, 0.0, 0.0),
                        max_speed: 80.0,
                        max_force: 2.0,
                    });
                }
                if let Some(atype) = req.anomaly_type.clone() {
                    ent_mut.insert(components::SpatialAnomaly {
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
    let clear_route = warp::post()
        .and(warp::path("clear"))
        .map(move || {
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
                if ent_type.0 == "player" || dying { continue; }
                
                let id_match = req.ids.as_ref().map_or(false, |ids| ids.contains(&entity.index()));
                let type_match = req.ent_type.as_ref().map_or(false, |t| t == &ent_type.0);
                
                // Color filtering requires querying PhysicsType, but for simplicity we rely on ent_type mapping
                let color_str = match ent_type.0.as_str() {
                    "player"    => "player",
                    "companion" => "companion",
                    "star"      => "star",
                    _           => "other",
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
                                PhysicsType::Orbital { ref mut radius, ref mut speed, .. } => {
                                    if let Some(r) = req.radius { *radius = r; }
                                    if let Some(s) = req.speed { *speed = s; }
                                }
                                PhysicsType::Sinusoidal { ref mut amplitude, ref mut frequency, .. } => {
                                    if let Some(a) = req.amplitude { *amplitude = a; }
                                    if let Some(f) = req.frequency { *frequency = f; }
                                }
                                _ => {}
                            }
                        }
                    }

                    // Update behavior policy if requested
                    if let Some(ref behavior) = req.behavior {
                        if let Some(mut steering) = w.get_mut::<components::SteeringAgent>(e) {
                            steering.behavior = behavior.clone();
                        }
                    }
                    modified_count += 1;
                }
            }
            warp::reply::json(&serde_json::json!({ "status": "modified", "count": modified_count }))
        });

    // GET /state — return a snapshot of active entities to the Python Director
    let world_for_get_state = world.clone();
    let get_state_route = warp::get()
        .and(warp::path("state"))
        .map(move || {
            let mut w = world_for_get_state.lock().unwrap();
            let mut entities_map = serde_json::Map::new();
            
            let mut query = w.query::<(Entity, &EntityType, Option<&components::SteeringAgent>, Option<&Transform>)>();
            for (entity, ent_type, steering_opt, trans_opt) in query.iter(&w) {
                let id_str = entity.index().to_string();
                let behavior = steering_opt.map(|s| s.behavior.clone()).unwrap_or_else(|| "none".to_string());
                
                let mut ent_obj = serde_json::Map::new();
                ent_obj.insert("id".to_string(), serde_json::Value::Number(serde_json::Number::from(entity.index())));
                ent_obj.insert("ent_type".to_string(), serde_json::Value::String(ent_type.0.clone()));
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
                    if let Some(mt) = req.model_type { visuals.model_type = Some(mt); }
                    if let Some(c) = req.color { visuals.color = c; }
                    if let Some(cloaked) = req.is_cloaked { visuals.is_cloaked = cloaked; }
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
    let world_for_reset = world.clone();
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
            }

            // Despawn restorable entity types, then re-spawn from snapshot
            const RESTORABLE: &[&str] = &["enemy", "alien_ship", "companion", "space_station"];
            let mut w = world_for_load.lock().unwrap();
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
                    eb.insert(SteeringAgent { velocity: (0.0, 0.0, 0.0), max_speed: 7.5, max_force: 0.5, behavior: "wander".to_string() });
                    eb.insert(Faction("pirate".to_string()));
                    eb.insert(SpatialAnomaly { anomaly_type: "alien".to_string(), mass: 0.0, radius: 100.0 });
                    eb.insert(WeaponParameters { projectile_count: 1, projectile_color: "#ff3333".to_string(), spread: 0.1, projectile_size: 6.0 });
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
                        if let Some(cnt) = proj_count { weapon.projectile_count = cnt; }
                        if let Some(ref clr) = proj_color { weapon.projectile_color = clr.clone(); }
                        if let Some(spr) = spread { weapon.spread = spr; }
                        if let Some(sz) = proj_size { weapon.projectile_size = sz; }
                    } else {
                        w.entity_mut(e).insert(WeaponParameters {
                            projectile_count: proj_count.unwrap_or(1),
                            projectile_color: proj_color.clone().unwrap_or_else(|| "#ef4444".to_string()),
                            spread: spread.unwrap_or(0.1),
                            projectile_size: proj_size.unwrap_or(8.0),
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
                        if let Some(ref mt) = new_model_type { vis.model_type = Some(mt.clone()); }
                        if let Some(ref c) = new_color { vis.color = c.clone(); }
                        if let Some(cl) = new_cloaked { vis.is_cloaked = cl; }
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
                    println!("[Engine] Despawned {} entities of type: {}", count, etype_target);
                }
            }
            
            warp::reply::json(&serde_json::json!({ "status": "command_received", "action": req.action }))
        });

    // POST /api/engine/next-level — Triggered by AI Director to autonomously finish a level
    let force_next_level: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
    let force_next_level_route = force_next_level.clone();
    let next_level_route = warp::post()
        .and(warp::path("api"))
        .and(warp::path("engine"))
        .and(warp::path("next-level"))
        .map(move || {
            println!("[Engine] Commander Override received. Advancing to next level.");
            *force_next_level_route.lock().unwrap() = true;
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
                if let Some(g) = req.gravity_scale { pc.gravity_scale = g; }
                if let Some(f) = req.friction { pc.friction = f; }
                if let Some(s) = req.projectile_speed_mult { pc.projectile_speed_mult = s; }
                println!("[Engine] Physics Updated -> G: {}, Fric: {}, Proj: {}", pc.gravity_scale, pc.friction, pc.projectile_speed_mult);
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
                    println!("[Engine] Faction Relation Updated: {} <-> {} = {}", update.faction_a, update.faction_b, update.affinity);
                }
            }
            warp::reply::json(&serde_json::json!({ "status": "factions_updated", "count": updates.len() }))
        });

    let routes = get_state_route.or(update_state).or(save_route).or(load_route).or(spawn_route).or(clear_route).or(despawn_route).or(modify_route).or(update_player_route).or(command_route).or(next_level_route).or(physics_route).or(factions_route).or(reset_route).with(state_cors);
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
            .allow_headers(vec!["User-Agent", "Sec-Fetch-Mode", "Referer", "Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Extensions", "Connection", "Upgrade"])
            .allow_methods(vec!["GET", "POST", "DELETE", "OPTIONS", "PUT", "PATCH"]);
        warp::serve(ws_route.with(cors)).run(([127, 0, 0, 1], 8081)).await;
    });
    
    // Main Game Loop (60 FPS)
    let player_target_for_loop = player_target.clone();
    let player_health_for_loop = player_health.clone();
    let damage_cooldown_for_loop = damage_cooldown.clone();
    let player_knockback_for_loop = player_knockback.clone();
    let total_kills_for_loop = total_kills.clone();
    let total_enemy_kills_for_loop = total_enemy_kills.clone();
    let total_asteroid_kills_for_loop = total_asteroid_kills.clone();
    let level_start_time_for_loop = level_start_time.clone();
    let game_over_timer_for_loop = game_over_timer.clone();
    let force_next_level_for_loop = force_next_level.clone();
    let do_full_reset_for_loop = do_full_reset.clone();
    let override_level_for_loop = override_level.clone();
    let current_level_shared_for_loop = current_level_shared.clone();
    let mut current_level: u32 = 1;
    let mut kills_at_level_start: u32 = 0;
    let mut enemy_kills_at_level_start: u32 = 0;
    let mut asteroid_kills_at_level_start: u32 = 0;
    let mut print_counter: u64 = 0;
    let mut last_shot_time = std::time::Instant::now();
    let mut last_tick_time = std::time::Instant::now();

    loop {
        // Real elapsed time since last tick — capped at 100ms to avoid huge jumps after pauses
        let tick_dt = last_tick_time.elapsed().as_secs_f64().min(0.1);
        last_tick_time = std::time::Instant::now();

        let mut success_kill_this_frame = false;
        if print_counter == 0 { println!("  [TICK START]"); }
        print_counter += 1;
        
        // Evaluate input for this frame
        let (thrust_forward, thrust_back, cam_yaw, cam_pitch, boost_active, shoot) = {
            let state = player_input_state.lock().unwrap();
            (state.up, state.down, state.cam_yaw, state.cam_pitch, state.boost, state.shoot)
        };

        let is_game_over_this_frame = *game_over_timer_for_loop.lock().unwrap() > 0.0;
        let shoot = shoot && !is_game_over_this_frame;
        let thrust_forward = thrust_forward && !is_game_over_this_frame;
        let thrust_back = thrust_back && !is_game_over_this_frame;

        let knockback = {
            let mut kb = player_knockback_for_loop.lock().unwrap();
            let v = *kb;
            kb.0 *= 0.82; // ~18-frame decay at 60 fps
            kb.1 *= 0.82;
            v
        };

        let mut projectiles_to_spawn: Vec<(f64, f64, f64, f64, f64, String, f64, Option<u32>)> = Vec::new(); // (x, y, z, yaw, pitch, color, size, target)

        let (speed_multiplier, gravity_mod, friction_mod) = {
            let rm = reality_for_sys.lock().unwrap();
            (rm.player_speed, rm.gravity, rm.friction)
        };

        {
            let mut w = world.lock().unwrap();

            // --- Check do_full_reset signal (from /api/engine/reset) ---
            let full_reset = {
                let mut flag = do_full_reset_for_loop.lock().unwrap();
                let v = *flag; *flag = false; v
            };
            if full_reset {
                current_level = 1;
                kills_at_level_start = 0;
                enemy_kills_at_level_start = 0;
                asteroid_kills_at_level_start = 0;
                *level_start_time_for_loop.lock().unwrap() = std::time::Instant::now();
                // Despawn enemies, companions, projectiles (keep solar system)
                let to_despawn: Vec<Entity> = {
                    let mut q = w.query::<(Entity, &EntityType)>();
                    q.iter(&w).filter(|(_, et)| {
                        matches!(et.0.as_str(), "enemy" | "alien_ship" | "companion" | "projectile" | "explosion")
                    }).map(|(e, _)| e).collect()
                };
                for e in to_despawn { w.despawn(e); }
                // Teleport player to spawn + reset ECS health + remove temp components
                let player_entities: Vec<Entity> = {
                    let mut q = w.query::<(Entity, &EntityType)>();
                    q.iter(&w).filter(|(_, et)| et.0 == "player").map(|(e, _)| e).collect()
                };
                for pe in player_entities {
                    if let Some(mut t) = w.get_mut::<Transform>(pe) {
                        t.x = 8500.0; t.y = 500.0; t.z = 0.0;
                    }
                    if let Some(mut phys) = w.get_mut::<PhysicsType>(pe) {
                        *phys = PhysicsType::Velocity { vx: 0.0, vy: 0.0, vz: 0.0 };
                    }
                    if let Some(mut h) = w.get_mut::<Health>(pe) { h.current = h.max; }
                    if let Some(mut v) = w.get_mut::<Visuals>(pe) {
                        *v = Visuals { model_type: Some("ufo".to_string()), color: "cyan".to_string(), is_cloaked: false };
                    }
                    if let Some(mut wp) = w.get_mut::<WeaponParameters>(pe) { *wp = WeaponParameters::default(); }
                    w.entity_mut(pe).remove::<DeathAge>().remove::<TargetLock>();
                }
                // Spawn a fresh initial wave
                spawn_wave(&mut w, 12, "pirate", "enemy", (3000.0, 28000.0), 0);
                println!("[Engine] Full reset complete. Level 1, fresh wave spawned.");
            }

            // --- Check override_level signal (from /load) ---
            if let Some(new_level) = override_level_for_loop.lock().unwrap().take() {
                current_level = new_level;
                kills_at_level_start = *total_kills_for_loop.lock().unwrap();
                enemy_kills_at_level_start = *total_enemy_kills_for_loop.lock().unwrap();
                asteroid_kills_at_level_start = *total_asteroid_kills_for_loop.lock().unwrap();
                *level_start_time_for_loop.lock().unwrap() = std::time::Instant::now();
                println!("[Engine] Level overridden to {}", current_level);
            }

            w.insert_resource(systems::RealityModifiersRes {
                gravity: gravity_mod,
                friction: friction_mod
            });
            w.insert_resource(systems::DeltaTime(tick_dt));

            schedule.run(&mut w);

            // --- HARD COLLISIONS: Pre-collect planetary bodies ---
            let mut planetary_bodies = Vec::new();
            {
                // The original query was limited to SpatialAnomaly, which not all planets have.
                // This new query is more general and calculates radius based on type/name.
                for (_, t, e, s, name_opt) in w.query::<(Entity, &Transform, &EntityType, Option<&components::Scale>, Option<&components::Name>)>().iter(&w) {
                    if e.0 == "sun" || e.0 == "planet" || e.0 == "moon" {
                        let r = if e.0 == "sun" { 1000.0 } else { 
                            // Use name-based radius matching EntityRenderer
                            let name = name_opt.map_or("", |n| &n.0);
                            let base = match name {
                                "Mercury" => 40.0,
                                "Venus" => 85.0,
                                "Earth" => 100.0,
                                "Mars" => 60.0,
                                "Jupiter" => 250.0,
                                "Saturn" => 210.0,
                                "Uranus" => 140.0,
                                "Neptune" => 130.0,
                                "Moon" => 20.0,
                                _ => 50.0, // Default for unknown planets/moons
                            };
                            base * s.map_or(1.0, |sc| sc.0)
                        };
                        planetary_bodies.push((t.x, t.y, t.z, r));
                    }
                }
            }

            let maybe_target = *player_target_for_loop.lock().unwrap();
            
            
            let mut p_x = 0.0;
            let mut p_y = 0.0;
            let mut p_alt = 0.0;
            let mut p_rot = 0.0;
            let mut ent_player = Entity::from_raw(0);
            let mut move_processed = false;

            {
                let dt = tick_dt; // Use real tick_dt instead of hardcoded 0.016
                let mut player_query = w.query::<(Entity, &EntityType, &mut Transform, &mut PhysicsType)>();
                for (entity, ent_type, mut transform, mut phys) in player_query.iter_mut(&mut w) {
                    if ent_type.0 == "player" {
                        ent_player = entity;

                        // Ship heading follows camera yaw from mouse
                        transform.rotation = cam_yaw;

                        if let PhysicsType::Velocity { ref mut vx, ref mut vy, ref mut vz } = *phys {
                            let mut thrust_force = 3000.0; // Reduced by a third from 4500.0
                            if boost_active { thrust_force *= 2.5; }

                            // Forward direction = camera facing in 3D (yaw + pitch)
                            let dir_x = cam_yaw.cos() * cam_pitch.cos();
                            let dir_y = cam_pitch.sin();
                            let dir_z = cam_yaw.sin() * cam_pitch.cos();

                            if thrust_forward {
                                *vx += dir_x * thrust_force * dt;
                                *vy += dir_y * thrust_force * dt;
                                *vz += dir_z * thrust_force * dt;
                            }
                            if thrust_back {
                                *vx -= dir_x * thrust_force * 0.6 * dt;
                                *vy -= dir_y * thrust_force * 0.6 * dt;
                                *vz -= dir_z * thrust_force * 0.6 * dt;
                            }

                            // Apply knockback impulse
                            *vx += knockback.0;
                            *vz += knockback.1;

                            // Drag - increased for smoother glide
                            let damping = 0.97; // Increased from 0.96
                            *vx *= damping;
                            *vy *= damping;
                            *vz *= damping;

                            // Integrate Position
                            transform.x += *vx * dt;
                            transform.y += *vy * dt;
                            transform.z += *vz * dt;

                            // Celestial Collisions (Sun, Planets, Moons)
                            for (ox, oy, oz, oradius) in &planetary_bodies {
                                let dx = transform.x - ox;
                                let dy = transform.y - oy;
                                let dz = transform.z - oz;
                                let dist_sq = dx * dx + dy * dy + dz * dz;
                                let combined_radius = oradius + 25.0; // ship_radius
                                if dist_sq < combined_radius * combined_radius {
                                    let dist = dist_sq.sqrt().max(0.1);
                                    let overlap = combined_radius - dist;
                                    transform.x += (dx / dist) * overlap;
                                    transform.y += (dy / dist) * overlap;
                                    transform.z += (dz / dist) * overlap;
                                    // Zero out velocity on collision for impact feel
                                    *vx = 0.0; *vy = 0.0; *vz = 0.0;
                                }
                            }
                        }
                            // Boundary Clamp (Hard Normalization)
                            let p_dist = (transform.x * transform.x + transform.z * transform.z).sqrt();
                            if p_dist > MAX_WORLD_RADIUS {
                                let factor = MAX_WORLD_RADIUS / p_dist;
                                transform.x *= factor;
                                transform.z *= factor;
                                
                                // Reset velocity if hitting boundary
                                if let PhysicsType::Velocity { ref mut vx, ref mut vz, .. } = *phys {
                                    *vx = 0.0;
                                    *vz = 0.0;
                                }
                            }

                            p_x = transform.x;
                            p_alt = transform.y;
                            p_y = transform.z; // Use p_y as depth Plane for legacy targeting compatibility
                            p_rot = transform.rotation;
                            move_processed = true;
                            break;
                        }
                    }
                }

            // --- AUTO-TARGETING ---
            let mut current_target_lock = None;
            {
                let mut target_query = w.query_filtered::<(Entity, &Transform, &EntityType, Option<&DeathAge>), Without<Projectile>>();
                let mut min_dist_sq = std::f64::MAX;
                for (t_e, t_t, t_type, death_age) in target_query.iter(&w) {
                    if death_age.is_none() && (t_type.0 == "enemy" || t_type.0 == "asteroid") {
                        let dx = p_x - t_t.x;
                        let dz = p_y - t_t.z; // p_y is player Z, t_t.z is target Z
                        let dist_sq = dx*dx + dz*dz;
                        if dist_sq < min_dist_sq && dist_sq < 9000000.0 { // lock up to 3000px away
                            min_dist_sq = dist_sq;
                            current_target_lock = Some(t_e.index());
                        }
                    }
                }
            }
            if let Some(target_id) = current_target_lock {
                w.entity_mut(ent_player).insert(components::TargetLock(target_id));
            } else {
                w.entity_mut(ent_player).remove::<components::TargetLock>();
            }

            if shoot && move_processed && last_shot_time.elapsed().as_secs_f64() > 0.15 {
                let wp = w.get::<WeaponParameters>(ent_player).cloned().unwrap_or_default();
                for i in 0..wp.projectile_count {
                    let mut offset_angle = 0.0;
                    if wp.projectile_count > 1 {
                        offset_angle = (i as f64 - (wp.projectile_count as f64 - 1.0) / 2.0) * wp.spread;
                    }
                    let final_rot = p_rot + offset_angle;
                    // Spawn projectiles 40 units ahead of the ship center to clear the mesh
                    projectiles_to_spawn.push((
                        p_x + final_rot.cos() * cam_pitch.cos() * 40.0,
                        p_alt + cam_pitch.sin() * 40.0,
                        p_y + final_rot.sin() * cam_pitch.cos() * 40.0,
                        final_rot,
                        cam_pitch,
                        wp.projectile_color.clone(),
                        wp.projectile_size,
                        current_target_lock,
                    ));
                }
                last_shot_time = std::time::Instant::now();
            }

            // --- AGGRO AI ---
            {
                let mut enemy_query = w.query::<(&EntityType, &mut Transform, &mut components::SteeringAgent, Option<&DeathAge>, Option<&WeaponParameters>)>();
                for (et, mut t, mut agent, death_age, weapon_opt) in enemy_query.iter_mut(&mut w) {
                    if death_age.is_none() && (et.0 == "enemy" || et.0 == "alien_ship") {
                        let dx = p_x - t.x;
                        let dy = p_alt - t.y;
                        let dz = p_y - t.z;
                        let dist_sq = dx * dx + dy * dy + dz * dz;
                        if dist_sq < 16_000_000.0 { // 4000 units range
                            agent.behavior = "attack".to_string();
                            let dist_xz = (dx * dx + dz * dz).sqrt().max(1.0);
                            let aim_yaw = dz.atan2(dx);
                            let aim_pitch = dy.atan2(dist_xz); // elevation toward player Y
                            t.rotation = aim_yaw;
                            if rand::random::<f64>() < 0.010 {
                                let (color, size, count, spread) = if let Some(wp) = weapon_opt {
                                    (wp.projectile_color.clone(), wp.projectile_size, wp.projectile_count, wp.spread)
                                } else {
                                    ("#ff3333".to_string(), 6.0_f64, 1_u32, 0.1_f64)
                                };
                                for shot_i in 0..count {
                                    let spread_offset = if count > 1 {
                                        (shot_i as f64 - (count as f64 - 1.0) * 0.5) * spread
                                    } else {
                                        0.0
                                    };
                                    projectiles_to_spawn.push((
                                        t.x, t.y, t.z,
                                        aim_yaw + spread_offset,
                                        aim_pitch,
                                        color.clone(),
                                        size,
                                        Some(ent_player.index()),
                                    ));
                                }
                            }
                        } else {
                            agent.behavior = "idle".to_string();
                        }
                    }
                }
            }

            // Tick all BirthAge and SpawnAge components
            {
                let mut age_query = w.query::<&mut BirthAge>();
                for mut age in age_query.iter_mut(&mut w) {
                    age.0 += 0.016;
                }
                let mut spawn_age_query = w.query::<(Entity, &mut SpawnAge)>();
                let mut to_despawn_spawnage: Vec<Entity> = Vec::new();
                for (entity, mut age) in spawn_age_query.iter_mut(&mut w) {
                    age.0 += 0.016;
                    if age.0 >= 0.5 {
                        to_despawn_spawnage.push(entity);
                    }
                }
                for e in to_despawn_spawnage {
                    w.despawn(e);
                }
            }



            // 1. Tick Projectile movement and Homing Steering
            let mut dead_projectiles: Vec<Entity> = Vec::new();
            
            // 1a. Pre-cache target positions for homing to satisfy borrow checker
            let mut target_positions = std::collections::HashMap::new();
            {
                let mut t_query = w.query::<(Entity, &Transform)>();
                for (e, t) in t_query.iter(&w) {
                    target_positions.insert(e.index(), (t.x, t.y));
                }
            }

            {
                let mut p_query = w.query::<(Entity, &mut Projectile, &mut Transform, Option<&components::TargetLock>)>();
                for (entity, mut proj, mut p_trans, lock_opt) in p_query.iter_mut(&mut w) {
                    proj.lifespan -= tick_dt;
                    
                    // Projectiles fly in a straight line now as intended for 3D

                    // Movement handled by PhysicsType::Projectile in the ECS schedule
                    
                    if proj.lifespan <= 0.0 {
                        dead_projectiles.push(entity);
                    }
                }
            }
            
            // Execute projectile despawn explicitly because we don't need them shattering and causing loops
            for e in dead_projectiles {
                w.despawn(e);
            }

            // 2. Combat Collision Detection
            let mut projectiles_info: Vec<(Entity, f64, f64, f64)> = Vec::new();
            {
                let mut p_query = w.query::<(Entity, &Transform, &Projectile)>();
                for (entity, t, _) in p_query.iter(&mut w) {
                    projectiles_info.push((entity, t.x, t.y, t.z));
                }
            }

            let mut target_info: Vec<(Entity, f64, f64, f64, String)> = Vec::new();
            {
                let mut target_query = w.query_filtered::<(Entity, &Transform, &EntityType, Option<&DeathAge>), Without<Projectile>>();
                for (entity, t, ent_type, da) in target_query.iter(&mut w) {
                    if da.is_none() && (ent_type.0 == "star" || ent_type.0 == "companion" || ent_type.0 == "enemy" || ent_type.0 == "asteroid") {
                        target_info.push((entity, t.x, t.y, t.z, ent_type.0.clone()));
                    }
                }
            }

            let mut combat_kills = 0;
            let mut enemy_kills_this_frame = 0;
            let mut asteroid_kills_this_frame = 0;
            let mut explosions_to_spawn: Vec<(f64, f64, f64)> = Vec::new(); // Queue for new 3D explosion entities
            let mut to_kill: Vec<Entity> = Vec::new(); // Queue for entity destruction

            for (p_entity, px, py, pz) in projectiles_info {
                for (t_entity, tx, ty, tz, t_type) in &target_info {
                    let dx = px - tx;
                    let dy = py - ty;
                    let dz = pz - tz;
                    if (dx*dx + dy*dy + dz*dz).sqrt() < 40.0 { // Increased 3D collision radius
                        to_kill.push(p_entity);
                        to_kill.push(*t_entity);
                        explosions_to_spawn.push((*tx, *ty, *tz)); // 3D explosion
                        combat_kills += 1;
                        success_kill_this_frame = true;
                        if t_type == "enemy" { enemy_kills_this_frame += 1; }
                        if t_type == "asteroid" { asteroid_kills_this_frame += 1; }
                        break;
                    }
                }
            }

            if combat_kills > 0 {
                // Accumulate into the global score counter
                *total_kills_for_loop.lock().unwrap() += combat_kills as u32;
                *total_enemy_kills_for_loop.lock().unwrap() += enemy_kills_this_frame as u32;
                *total_asteroid_kills_for_loop.lock().unwrap() += asteroid_kills_this_frame as u32;
                tokio::spawn(async move {
                    let client = reqwest::Client::new();
                    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
                    let payload = serde_json::json!({
                        "event_type": "combat_kill",
                        "count": combat_kills,
                        "cause": "player_shot",
                        "timestamp": format!("{}", ts)
                    });
                    let _ = client.post("http://127.0.0.1:8000/engine_telemetry")
                        .json(&payload)
                        .send()
                        .await;
                });
            }

            // 2.5. AI-vs-AI Faction Collision Detection
            // Opposing factions (pirate vs federation) destroy each other on proximity.
            {
                let mut faction_entities: Vec<(Entity, f64, f64, f64, String)> = Vec::new();
                {
                    let mut fq = w.query_filtered::<(Entity, &Transform, &Faction, &EntityType, Option<&DeathAge>), Without<Projectile>>();
                    for (entity, t, faction, ent_type, death_age) in fq.iter(&w) {
                        if death_age.is_none() && ent_type.0 != "player" && ent_type.0 != "planet" && ent_type.0 != "sun" {
                            faction_entities.push((entity, t.x, t.y, t.z, faction.0.clone()));
                        }
                    }
                }

                let mut faction_kills = 0u32;
                let mut already_killed = std::collections::HashSet::new();
                for i in 0..faction_entities.len() {
                    if already_killed.contains(&faction_entities[i].0) { continue; }
                    for j in (i + 1)..faction_entities.len() {
                        if already_killed.contains(&faction_entities[j].0) { continue; }
                        let (_, ax, ay, az, ref af) = faction_entities[i];
                        let (_, bx, by, bz, ref bf) = faction_entities[j];
                        // Check hostility: pirate <-> federation
                        let hostile = (af == "pirate" && bf == "federation") || (af == "federation" && bf == "pirate");
                        if !hostile { continue; }
                        let dx = ax - bx;
                        let dy = ay - by;
                        let dz = az - bz;
                        if dx * dx + dy * dy + dz * dz < 2500.0 { // 50px radius in 3D
                            to_kill.push(faction_entities[i].0);
                            to_kill.push(faction_entities[j].0);
                            already_killed.insert(faction_entities[i].0);
                            already_killed.insert(faction_entities[j].0);
                            explosions_to_spawn.push((ax, ay, az));
                            explosions_to_spawn.push((bx, by, bz));
                            faction_kills += 1;
                        }
                    }
                }

                if faction_kills > 0 {
                    *total_kills_for_loop.lock().unwrap() += faction_kills;
                    tokio::spawn(async move {
                        let client = reqwest::Client::new();
                        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
                        let payload = serde_json::json!({
                            "event_type": "combat_kill",
                            "count": faction_kills,
                            "cause": "faction_war",
                            "timestamp": format!("{}", ts)
                        });
                        let _ = client.post("http://127.0.0.1:8000/engine_telemetry")
                            .json(&payload)
                            .send()
                            .await;
                    });
                }
            }

            // 3. Black Hole Simulation
            {
                let mut anomaly_query = w.query::<(&SpatialAnomaly, &Transform)>();
                let mut agent_query = w.query_filtered::<(Entity, &Transform, Option<&DeathAge>), Without<SpatialAnomaly>>();
                
                for (anomaly, a_trans) in anomaly_query.iter(&w) {
                    if anomaly.anomaly_type == "black_hole" || anomaly.anomaly_type == "sun" {
                        for (entity, t, death_age) in agent_query.iter(&w) {
                            if death_age.is_none() {
                                // PLANET & PLAYER IMMUNITY
                                let mut is_immune = false;
                                if let Some(ent_type) = w.get::<EntityType>(entity) {
                                    if ent_type.0 == "planet" || ent_type.0 == "player" || ent_type.0 == "sun" {
                                        is_immune = true;
                                    }
                                }

                                if !is_immune {
                                    let dx = a_trans.x - t.x;
                                    let dy = a_trans.y - t.y;
                                    let dz = a_trans.z - t.z;
                                    if (dx*dx + dy*dy + dz*dz).sqrt() < anomaly.radius * 0.5 {
                                        to_kill.push(entity);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            
            let anomaly_kill_count = to_kill.len();
            for e in to_kill {
                if let Some(mut entity_mut) = w.get_entity_mut(e) {
                    entity_mut.insert(DeathAge(0.0));
                }
            }
            
            if anomaly_kill_count > 0 {
                tokio::spawn(async move {
                    let client = reqwest::Client::new();
                    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
                    let payload = serde_json::json!({
                        "event_type": "anomaly_kill",
                        "count": anomaly_kill_count,
                        "cause": "black_hole",
                        "timestamp": format!("{}", ts)
                    });
                    let _ = client.post("http://127.0.0.1:8000/engine_telemetry")
                        .json(&payload)
                        .send()
                        .await;
                });
            }

            // ---- Player Damage System ----
            {
                let cd = *damage_cooldown_for_loop.lock().unwrap();
                let got = *game_over_timer_for_loop.lock().unwrap();

                if got <= 0.0 && cd <= 0.0 {
                    // Step 1: collect player position
                    let (px, py, pz) = {
                        let mut pq = w.query::<(&EntityType, &Transform)>();
                        let mut pos = (0.0_f64, 0.0_f64, 0.0_f64);
                        for (et, t) in pq.iter(&w) {
                            if et.0 == "player" { pos = (t.x, t.y, t.z); break; }
                        }
                        pos
                    };

                    // Step 2: collect hostile entities in collision range
                    let mut hostile_hits: Vec<(Entity, String)> = Vec::new();
                    let mut hit_dir = (0.0_f64, 0.0_f64, 0.0_f64);
                    {
                        let mut hq = w.query::<(Entity, &Transform, &EntityType, Option<&DeathAge>, Option<&Faction>)>();
                        for (e, t, et, da, faction_opt) in hq.iter(&w) {
                            if da.is_some() { continue; }
                            if et.0 == "enemy" || et.0 == "asteroid" {
                                if let Some(f) = faction_opt {
                                    if f.0 == "federation" { continue; }
                                }
                                let dx = px - t.x;
                                let dy = py - t.y;
                                let dz = pz - t.z;
                                let dist = (dx * dx + dy * dy + dz * dz).sqrt();
                                if dist < 55.0 { // Increased 3D collision radius for player
                                    if hit_dir == (0.0, 0.0, 0.0) {
                                        let d = dist.max(1.0);
                                        hit_dir = (dx / d, dy / d, dz / d);
                                    }
                                    hostile_hits.push((e, et.0.clone()));
                                }
                            }
                        }
                    }

                    if !hostile_hits.is_empty() {
                        let mut hits_this_frame = 0;
                        let mut enemies_hit = 0;
                        let mut asteroids_hit = 0;

                        // Apply damage and invincibility window
                        let new_health = {
                            let mut h = player_health_for_loop.lock().unwrap();
                            *h = (*h - 20.0).max(0.0);
                            *h
                        };
                        *damage_cooldown_for_loop.lock().unwrap() = 1.0; 
                        *player_knockback_for_loop.lock().unwrap() = (hit_dir.0 * 520.0, hit_dir.1 * 520.0);

                        for (e, et_type) in &hostile_hits {
                            if let Some(mut em) = w.get_entity_mut(*e) {
                                em.insert(DeathAge(0.0));
                                hits_this_frame += 1;
                                if et_type == "enemy" { enemies_hit += 1; }
                                if et_type == "asteroid" { asteroids_hit += 1; }
                            }
                        }

                        // Credit kills to the player for colliding!
                        if hits_this_frame > 0 {
                            *total_kills_for_loop.lock().unwrap() += hits_this_frame as u32;
                            *total_enemy_kills_for_loop.lock().unwrap() += enemies_hit as u32;
                            *total_asteroid_kills_for_loop.lock().unwrap() += asteroids_hit as u32;
                            success_kill_this_frame = true;
                        }

                        // Game Over condition
                        if new_health <= 0.0 {
                            *game_over_timer_for_loop.lock().unwrap() = 3.0;

                            // Shatter the Player visually — spawn golden explosion particles
                            let mut rng = rand::thread_rng();
                            for _ in 0..35 {
                                let angle = rng.gen_range(0.0..std::f64::consts::TAU);
                                let speed = rng.gen_range(160.0..440.0);
                                w.spawn((
                                    Particle {
                                        velocity: (angle.cos() * speed, angle.sin() * speed, rng.gen_range(-80.0..80.0)),
                                        lifespan: 1.8,
                                        max_lifespan: 1.8,
                                        color: "rgba(255, 210, 60, 0.95)".to_string(),
                                    },
                                    Transform { x: px, y: py, z: 0.0, rotation: 0.0 },
                                ));
                            }

                            // Send game_over event to Python Director
                            let score_val = *total_kills_for_loop.lock().unwrap();
                            tokio::spawn(async move {
                                let client = reqwest::Client::new();
                                let ts = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap()
                                    .as_secs();
                                let payload = serde_json::json!({
                                    "event_type": "game_over",
                                    "count": score_val,
                                    "cause": "player_destroyed",
                                    "timestamp": format!("{}", ts)
                                });
                                let _ = client.post("http://127.0.0.1:8000/engine_telemetry")
                                    .json(&payload)
                                    .send()
                                    .await;
                            });
                        }
                    }
                }

                // Tick invincibility cooldown
                {
                    let mut cd = damage_cooldown_for_loop.lock().unwrap();
                    if *cd > 0.0 { *cd = (*cd - 0.016).max(0.0); }
                }

                // Tick game-over timer; reset player after 3 s
                {
                    let mut got = game_over_timer_for_loop.lock().unwrap();
                    if *got > 0.0 {
                        *got = (*got - 0.016).max(0.0);
                        if *got <= 0.0 {
                            // Resurrect: restore health and teleport back to origin
                            *player_health_for_loop.lock().unwrap() = 100.0;
                            let mut pq = w.query::<(&EntityType, &mut Transform)>();
                            for (et, mut t) in pq.iter_mut(&mut w) {
                                if et.0 == "player" {
                                    t.x = 300.0;
                                    t.y = 0.0;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            // ---- End Player Damage System ----

            // Tick DeathAge and despawn if > 1.0s. Keep track of shatters.
            let mut death_query = w.query::<(Entity, &mut DeathAge, &Transform, &EntityType)>();
            let mut entities_to_despawn = Vec::new();
            let mut entities_to_shatter = Vec::new();
            
            for (entity, mut death_age, transform, ent_type) in death_query.iter_mut(&mut w) {
                // If it's a fresh death (age 0), stage for shattering
                if death_age.0 == 0.0 && ent_type.0 != "anomaly" {
                    entities_to_shatter.push((transform.x, transform.y, transform.z));
                }
                
                death_age.0 += 0.016;
                // Entity is fully dead after 1.0 seconds
                if death_age.0 >= 1.0 {
                    entities_to_despawn.push(entity);
                }
            }
            
            // 4. (Deprecated) Particle Shatters removed in favor of 3D Explosions
            // Kept dead particle cleanup just in case.
            for e in entities_to_despawn {
                w.despawn(e);
            }
            
            // Spawn 3D Explosions
            for (ex, ey, ez) in explosions_to_spawn {
                w.spawn((
                    EntityType("explosion".to_string()),
                    Transform { x: ex, y: ey, z: ez, rotation: 0.0 }, // Fixed: Use ez
                    SpawnAge(0.0), 
                    Visuals { model_type: Some("sphere".to_string()), color: "#f59e0b".to_string(), is_cloaked: false }
                ));
            }
            
            // Cleanup dead particles
            let mut dead_particles: Vec<Entity> = Vec::new();
            let mut particle_query = w.query::<(Entity, &Particle)>();
            for (entity, particle) in particle_query.iter(&w) {
                if particle.lifespan <= 0.0 {
                    dead_particles.push(entity);
                }
            }
            for e in dead_particles {
                w.despawn(e);
            }
        }

        if projectiles_to_spawn.len() > 0 {
            let mut w = world.lock().unwrap();
            // Safety cap: never exceed 300 live projectiles to prevent server slowdown
            let live_count = { let mut q = w.query::<&Projectile>(); q.iter(&w).count() };
            if live_count >= 300 { projectiles_to_spawn.clear(); }
            for (px, py, pz, prot, ppitch, pcolor, psize, target_lock) in projectiles_to_spawn {
                let mut ent = w.spawn((
                    EntityType("projectile".to_string()),
                    Transform { x: px, y: py, z: pz, rotation: prot },
                    Projectile {
                        velocity: (0.0, 0.0, 0.0), // unused — PhysicsType::Projectile drives movement
                        lifespan: 2.5,
                        color: pcolor,
                        size: psize,
                    },
                    PhysicsType::Projectile { speed: 50.0, pitch_angle: ppitch },
                    components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
                ));
                if let Some(target_id) = target_lock {
                    ent.insert(components::TargetLock(target_id));
                }
            }
        }

        // --- LEVEL PROGRESSION SYSTEM ---
        let current_score = *total_kills_for_loop.lock().unwrap();
        let current_enemy_kills = *total_enemy_kills_for_loop.lock().unwrap();
        let current_asteroid_kills = *total_asteroid_kills_for_loop.lock().unwrap();
        let elapsed_time = level_start_time_for_loop.lock().unwrap().elapsed().as_secs();

        let mut objective = "".to_string();
        let mut level_advanced = false;

        // --- PHASE 8.6: BOUNDARY WARNING ---
        let mut out_of_bounds = false;
        {
            let mut w = world.lock().unwrap();
            let mut pq = w.query::<(&EntityType, &Transform)>();
            for (et, t) in pq.iter(&w) {
                if et.0 == "player" {
                    let dist = (t.x * t.x + t.y * t.y + t.z * t.z).sqrt();
                    if dist > MAX_WORLD_RADIUS {
                        out_of_bounds = true;
                    }
                    break;
                }
            }
        }

        {
            let mut w = world.lock().unwrap();
            
            let mut p_pos = (0.0, 0.0);
            let mut mars_pos = (std::f64::MAX, std::f64::MAX);
            let mut jup_pos = (std::f64::MAX, std::f64::MAX);
            
            {
                let mut tq = w.query::<(&EntityType, Option<&Name>, &Transform)>();
                for (et, name, t) in tq.iter(&w) {
                    if et.0 == "player" { p_pos = (t.x, t.z); }
                    if let Some(n) = name {
                        if n.0 == "Mars" { mars_pos = (t.x, t.z); }
                        if n.0 == "Jupiter" { jup_pos = (t.x, t.z); }
                    }
                }
            }

            let dist_to_mars = ((p_pos.0 - mars_pos.0).powi(2) + (p_pos.1 - mars_pos.1).powi(2)).sqrt();
            let dist_to_jupiter = ((p_pos.0 - jup_pos.0).powi(2) + (p_pos.1 - jup_pos.1).powi(2)).sqrt();

            let target_kills = current_score.saturating_sub(kills_at_level_start);
            let enemy_kills = current_enemy_kills.saturating_sub(enemy_kills_at_level_start);
            let asteroid_kills = current_asteroid_kills.saturating_sub(asteroid_kills_at_level_start);

            let mut force_advance = false;
            {
                let mut fnl = force_next_level_for_loop.lock().unwrap();
                if *fnl {
                    force_advance = true;
                    *fnl = false;
                }
            }

            if force_advance {
                current_level += 1;
                objective = format!("COMMANDER OVERRIDE: Advancing to Level {}", current_level);
                level_advanced = true;
                
                // Handled in level_advanced block
            } else if current_level == 1 {
                objective = format!("LEVEL 1: Destroy 15 targets ({}/15)", target_kills);
                if target_kills >= 15 { current_level = 2; level_advanced = true; }
            } else if current_level == 2 {
                objective = format!("LEVEL 2: Destroy 5 Enemy Ships ({}/5)", enemy_kills);
                if enemy_kills >= 5 { current_level = 3; level_advanced = true; }
            } else if current_level == 3 {
                objective = format!("LEVEL 3: Survive for 60 seconds ({}s/60s)", elapsed_time);
                if elapsed_time >= 60 { current_level = 4; level_advanced = true; }
            } else if current_level == 4 {
                objective = format!("LEVEL 4: Destroy 25 mixed targets ({}/25)", target_kills);
                if target_kills >= 25 { current_level = 5; level_advanced = true; }
            } else if current_level == 5 {
                let m_fmt = if dist_to_mars < 3000.0 { "Mars Reached".to_string() } else { format!("Dist: {:.0}", dist_to_mars) };
                objective = format!("LEVEL 5: Reach Mars & Destroy 10 Enemies [{}, {}/10]", m_fmt, enemy_kills);
                if dist_to_mars < 3000.0 && enemy_kills >= 10 { current_level = 6; level_advanced = true; }
            } else if current_level == 6 {
                objective = format!("LEVEL 6: Destroy 40 Asteroids ({}/40)", asteroid_kills);
                if asteroid_kills >= 40 { current_level = 7; level_advanced = true; }
            } else if current_level == 7 {
                objective = format!("LEVEL 7: Survive for 90 seconds ({}s/90s)", elapsed_time);
                if elapsed_time >= 90 { current_level = 8; level_advanced = true; }
            } else if current_level == 8 {
                let j_fmt = if dist_to_jupiter < 4000.0 { "Jupiter Reached".to_string() } else { format!("Dist: {:.0}", dist_to_jupiter) };
                objective = format!("LEVEL 8: Reach Jupiter & Destroy 20 Enemies [{}, {}/20]", j_fmt, enemy_kills);
                if dist_to_jupiter < 4000.0 && enemy_kills >= 20 { current_level = 9; level_advanced = true; }
            } else if current_level == 9 {
                objective = format!("LEVEL 9: Destroy 50 mixed targets ({}/50)", target_kills);
                if target_kills >= 50 { current_level = 10; level_advanced = true; }
            } else if current_level == 10 {
                objective = format!("FINAL WAVE: Survive 3m ({}s/180s) or kill 100 targets ({}/100)", elapsed_time, target_kills);
                if elapsed_time >= 180 || target_kills >= 100 { 
                    objective = "VICTORY: The Void is quiet.".to_string(); 
                    current_level = 11;
                }
            } else {
                objective = "VICTORY: The Void is quiet.".to_string();
            }

            if out_of_bounds {
                objective = "Pilot, you are leaving the mission sector. Return immediately.".to_string();
            }

            if level_advanced {
                println!(">>> ADVANCED TO LEVEL {}! <<<", current_level);
                
                // --- PHASE 8.3: WORLD CLEAR PASS ---
                // Despawn old enemies, asteroids, and projectiles to prevent clutter and ensure fresh level start
                let mut to_cleanup: Vec<Entity> = Vec::new();
                {
                    let mut q = w.query::<(Entity, &EntityType)>();
                    for (e, et) in q.iter(&w) {
                        if et.0 == "enemy" || et.0 == "asteroid" || et.0 == "projectile" {
                            to_cleanup.push(e);
                        }
                    }
                }
                for e in to_cleanup {
                    w.despawn(e);
                }

                // --- PHASE 8.3: DYNAMIC WAVE SPAWNING ---
                // Ensure a base wave level spawns even if not explicitly defined in the level ladder
                let enemy_count = (current_level as usize * 2) + 2; // Slightly more enemies
                let range = if current_level <= 2 {
                    (1500.0, 4000.0) // Much closer for early verification
                } else {
                    (3000.0 + (current_level as f64 * 500.0), 6000.0 + (current_level as f64 * 1000.0))
                };
                
                // Tier logic: Higher levels spawn scarier ships
                let variant = if current_level >= 10 { 2 } else if current_level >= 5 { 1 } else { 0 };
                spawn_wave(&mut w, enemy_count, "pirate", "enemy", range, variant);
                
                kills_at_level_start = current_score;
                enemy_kills_at_level_start = current_enemy_kills;
                asteroid_kills_at_level_start = current_asteroid_kills;
                *level_start_time_for_loop.lock().unwrap() = std::time::Instant::now();
            }
        }
        
        let mut entities_data: Vec<EntityData> = Vec::new();
        let mut particles_data: Vec<ParticleData> = Vec::new();
        let mut player_pos = (0.0_f64, 0.0_f64);

        // First pass: collect all entity data and find player position
        {
            let mut w = world.lock().unwrap();
            let mut query = w.query::<(
                Entity,
                &Transform,
                &EntityType,
                (Option<&PhysicsType>, Option<&BirthAge>, Option<&DeathAge>),
                (Option<&SteeringAgent>, Option<&SpatialAnomaly>, Option<&Projectile>),
                (Option<&Faction>, Option<&Visuals>, Option<&Parent>),
                (Option<&SpawnAge>, Option<&PersistentId>, Option<&ModelVariant>, Option<&Scale>, Option<&Name>, Option<&TargetLock>, Option<&Health>)
            )>();
            for (
                entity,
                transform,
                ent_type,
                (phys_type, birth_age, death_age),
                (steering, anomaly, _projectile),
                (faction_opt, visuals, parent_opt),
                (spawn_age_opt, persistent_id_opt, variant_opt, scale_opt, name_opt, target_lock_opt, health_opt)
            ) in query.iter(&w) {
                let speed: f64 = match phys_type {
                    Some(PhysicsType::Orbital { speed, .. }) => *speed,
                    Some(PhysicsType::Sinusoidal { frequency, .. }) => frequency * 0.3,
                    Some(PhysicsType::Projectile { speed, .. }) => *speed,
                    Some(PhysicsType::Velocity { vx, vy, vz }) => (vx*vx + vy*vy + vz*vz).sqrt(),
                    Some(PhysicsType::Static) | None => 0.0,
                };
                let is_newborn = birth_age.map_or(false, |b: &BirthAge| b.0 < 2.0);
                let is_dying = death_age.is_some();
                let behavior = steering.map_or("idle".to_string(), |s| s.behavior.clone());
                let faction = faction_opt.map_or("neutral".to_string(), |f| f.0.clone());
                
                let (anomaly_type, anomaly_radius) = match anomaly {
                    Some(a) => (Some(a.anomaly_type.clone()), Some(a.radius)),
                    None => (None, None),
                };

                let mut model_type = None;
                let mut custom_color = None;
                let mut projectile_size_out: Option<f64> = None;

                let color = match ent_type.0.as_str() {
                    "player"     => "player",
                    "companion"  => "companion",
                    "star"       => "star",
                    "anomaly"    => "anomaly",
                    "projectile" => "projectile",
                    _            => "other",
                };

                let mut is_cloaked = false;
                if let Some(v) = visuals {
                    model_type = v.model_type.clone();
                    custom_color = Some(v.color.clone());
                    is_cloaked = v.is_cloaked;
                }
                // Projectiles carry color and size directly on the component
                if let Some(proj) = _projectile {
                    custom_color = Some(proj.color.clone());
                    projectile_size_out = Some(proj.size);
                }

                if ent_type.0 == "player" {
                    player_pos = (transform.x, transform.z);
                }
                let scale = scale_opt.map(|s| s.0);
                let model_variant = variant_opt.map(|m| m.0);
                let name = name_opt.map(|n| n.0.clone());

                entities_data.push(EntityData {
                    id: entity.index(),
                    x: transform.x,
                    y: transform.y,
                    z: transform.z,
                    rotation: transform.rotation,
                    speed,
                    ent_type: ent_type.0.clone(),
                    color: color.to_string(),
                    is_newborn,
                    is_dying,
                    behavior,
                    faction,
                    name,
                    radius: match ent_type.0.as_str() {
                        "sun"    => Some(120.0),
                        "planet" => Some(anomaly.map_or(20.0, |a| a.radius)),
                        "enemy"  => Some(if model_variant == Some(2) { 100.0 } else if model_variant == Some(1) { 40.0 } else { 18.0 }),
                        "companion" => Some(18.0),
                        _        => None,
                    },
                    anomaly_type,
                    anomaly_radius,
                    model_type,
                    custom_color,
                    parent_id: parent_opt.map(|p| p.0),
                    spawn_age: spawn_age_opt.map(|s| s.0),
                    persistent_id: persistent_id_opt.map(|p| p.0),
                    target_lock_id: target_lock_opt.map(|l| l.0),
                    is_cloaked,
                    scale,
                    model_variant,
                    projectile_size: projectile_size_out,
                    health_current: health_opt.map(|h| h.current),
                    health_max: health_opt.map(|h| h.max),
                });
            }
            
            // Extract core particle data
            let mut p_query = w.query::<(&Transform, &Particle)>();
            for (transform, particle) in p_query.iter(&w) {
                particles_data.push(ParticleData {
                    x: transform.x,
                    y: transform.y,
                    z: transform.z,
                    lifespan: particle.lifespan,
                    max_lifespan: particle.max_lifespan,
                    color: particle.color.clone(),
                });
            }
        } // drop world lock

        // Distance culling: only send asteroids within 3000 units of the player.
        // 5000 asteroids exist in the world but only ~30-50 are nearby at any time.
        // This keeps frame payload small for consistent 60fps.
        {
            let view_radius_sq = 3000.0_f64 * 3000.0_f64;
            let (px, pz) = player_pos;
            entities_data.retain(|ent| {
                if ent.ent_type == "asteroid" {
                    let dx = ent.x - px;
                    let dz = ent.z - pz;
                    dx * dx + dz * dz <= view_radius_sq
                } else {
                    true
                }
            });
        }

        // Collision detection: broadcast collision_event for any star within 20px of player
        let collision_clients = clients.clone();
        for ent in &entities_data {
            if ent.ent_type == "star" {
                let dx = player_pos.0 - ent.x;
                let dz = player_pos.1 - ent.z;
                let d = (dx * dx + dz * dz).sqrt();
                if d < 20.0 {
                    let event = CollisionEvent {
                        msg_type: "collision_event".to_string(),
                        star_id: ent.id,
                        speed: ent.speed,
                        distance: d,
                    };
                    if let Ok(json) = serde_json::to_string(&event) {
                        let msg = warp::ws::Message::text(json);
                        let mut cg = collision_clients.lock().unwrap();
                        cg.retain(|client| client.send(Ok(msg.clone())).is_ok());
                    }
                    break; // One collision event per frame is enough
                }
            }
        }
        
        let (env_theme, env_terrain) = {
            let wstate = state.lock().unwrap();
            (wstate.environment_theme.clone(), wstate.terrain_rules.clone())
        };

        // Keep current_level_shared in sync so save route can read it
        *current_level_shared_for_loop.lock().unwrap() = current_level;

        let current_health = *player_health.lock().unwrap();
        let current_score = *total_kills.lock().unwrap();
        let current_game_over = *game_over_timer.lock().unwrap() > 0.0;

        let update = RenderFrameState {
            msg_type: "render_frame".to_string(),
            environment_theme: env_theme,
            terrain_rules: env_terrain,
            grid: SpatialGrid {
                size: 2000.0,
                divisions: 40,
            },
            entities: entities_data,
            particles: particles_data,
            player_health: current_health,
            score: current_score,
            current_level: current_level,
            is_game_over: current_game_over,
            objective: objective,
            kills_in_level: current_score, // Simplified tracker
            success_kill: success_kill_this_frame,
        };
        
        match serde_json::to_string(&update) {
            Ok(json) => {
                let msg = warp::ws::Message::text(json);
                let mut clients_guard = clients.lock().unwrap();
                let client_count = clients_guard.len();
                
                // --- DIAGNOSTIC PRINT (Prints every 'print_counter' frames) ---
                if print_counter % 60 == 0 {
                    println!("[DIAGNOSTIC] Frame {} - Broadcasting to {} clients", print_counter, client_count);
                }
                print_counter += 1;
                
                clients_guard.retain(|client| {
                    if let Err(_) = client.send(Ok(msg.clone())) {
                        false
                    } else {
                        true
                    }
                });
            }
            Err(e) => {
                println!("CRITICAL ERROR: Failed to serialize RenderFrameState: {}", e);
            }
        }
        
        tokio::time::sleep(std::time::Duration::from_millis(16)).await; // ~60fps
    }
}

async fn client_connection(ws: warp::ws::WebSocket, clients: Clients, input_state: Arc<Mutex<PlayerInputState>>) {
    let (tx, mut rx) = ws.split();
    let (client_tx, client_rx) = mpsc::unbounded_channel();
    let client_rx = tokio_stream::wrappers::UnboundedReceiverStream::new(client_rx);
    
    tokio::task::spawn(client_rx.forward(tx));
    clients.lock().unwrap().push(client_tx);
    
    while let Some(result) = rx.next().await {
        match result {
            Ok(msg) => {
                if msg.is_text() {
                    if let Ok(text) = msg.to_str() {
                        if let Ok(cmd) = serde_json::from_str::<PlayerInputMessage>(text) {
                            if cmd.msg_type == "player_input" {
                                let mut state = input_state.lock().unwrap();
                                state.up = cmd.keys.contains(&"KeyW".to_string()) || cmd.keys.contains(&"ArrowUp".to_string());
                                state.down = cmd.keys.contains(&"KeyS".to_string()) || cmd.keys.contains(&"ArrowDown".to_string());
                                state.left = cmd.keys.contains(&"KeyA".to_string()) || cmd.keys.contains(&"ArrowLeft".to_string());
                                state.right = cmd.keys.contains(&"KeyD".to_string()) || cmd.keys.contains(&"ArrowRight".to_string());
                                state.shoot = cmd.keys.contains(&"Space".to_string());
                                state.boost = cmd.keys.contains(&"ShiftLeft".to_string()) || cmd.keys.contains(&"ShiftRight".to_string());
                                state.cam_yaw = cmd.cam_yaw;
                                state.cam_pitch = cmd.cam_pitch;
                            }
                        }
                    }
                }
            }
            Err(_) => {
                break;
            }
        }
    }
}

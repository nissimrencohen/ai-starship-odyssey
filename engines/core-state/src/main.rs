mod components;
mod systems;

use bevy_ecs::prelude::*;
use warp::Filter;
use std::sync::{Arc, Mutex};
use components::{WorldState, Transform, EntityType, Name, PhysicsType, BirthAge, DeathAge, SteeringAgent, SpatialAnomaly, Particle, Projectile, PlayerInputMessage, Health, Faction, Visuals, UpdatePlayerRequest, Parent, SpawnAge, WeaponParameters, CommandRequest};
use serde::{Serialize, Deserialize};
use futures_util::StreamExt;
use tokio::sync::mpsc;
use rand::Rng;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};

// Global Entity ID counter for external AI targeting
static GLOBAL_ENTITY_ID: AtomicU64 = AtomicU64::new(1);

type Clients = Arc<Mutex<Vec<mpsc::UnboundedSender<Result<warp::ws::Message, warp::Error>>>>>;

struct PlayerInputState {
    pub up: bool,
    pub down: bool,
    pub left: bool,
    pub right: bool,
    pub shoot: bool,
}

impl Default for PlayerInputState {
    fn default() -> Self {
        Self { up: false, down: false, left: false, right: false, shoot: false }
    }
}

#[derive(Serialize)]
struct EntityData {
    id: u32,
    x: f32,
    y: f32,
    z: f32,
    rotation: f32,
    speed: f32,
    ent_type: String,
    color: String,
    is_newborn: bool,
    is_dying: bool,
    behavior: String,
    faction: String,
    name: Option<String>,
    radius: Option<f32>,
    anomaly_type: Option<String>,
    anomaly_radius: Option<f32>,
    model_type: Option<String>,
    custom_color: Option<String>,
    parent_id: Option<u32>,
    spawn_age: Option<f32>,
    persistent_id: Option<u64>,
    target_lock_id: Option<u32>,
}

#[derive(Deserialize, Debug)]
struct SpawnEntityRequest {
    ent_type: String,
    x: f32,
    y: f32,
    physics: String,
    faction: Option<String>,
    radius: Option<f32>,
    speed: Option<f32>,
    amplitude: Option<f32>,
    frequency: Option<f32>,
    anomaly_type: Option<String>,
    mass: Option<f32>,
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
    radius: Option<f32>,
    speed: Option<f32>,
    amplitude: Option<f32>,
    frequency: Option<f32>,
    behavior: Option<String>,
}

#[derive(Serialize)]
struct CollisionEvent {
    #[serde(rename = "type")]
    msg_type: String,
    star_id: u32,
    speed: f32,
    distance: f32,
}

#[derive(Serialize)]
struct SpatialGrid {
    size: f32,
    divisions: u32,
}

#[derive(Serialize)]
struct ParticleData {
    x: f32,
    y: f32,
    z: f32,
    lifespan: f32,
    max_lifespan: f32,
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
    player_health: f32,
    score: u32,
    current_level: u32,
    is_game_over: bool,
    objective: String,
    kills_in_level: u32,
    success_kill: bool,
}

// ---------- Helpers for Level Progression ----------
fn spawn_wave(w: &mut World, count: usize, faction: &str, ent_type: &str, dist_range: (f32, f32)) {
    let mut rng = rand::thread_rng();
    for _ in 0..count {
        let radius = rng.gen_range(dist_range.0..dist_range.1); 
        let angle = rng.gen_range(0.0..std::f32::consts::TAU);
        let speed = rng.gen_range(20.0..60.0);
        let mut ent_mut = w.spawn((
            components::EntityType(ent_type.to_string()),
            components::Transform { x: angle.cos() * radius, y: angle.sin() * radius, z: 0.0, rotation: angle },
            components::PhysicsType::Orbital { radius, speed: rng.gen_range(0.5..1.5), angle },
            components::BirthAge(0.0),
            components::Faction(faction.to_string()),
            components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
        ));
        
        if ent_type == "enemy" || ent_type == "companion" {
            ent_mut.insert(components::SteeringAgent {
                behavior: "attack".to_string(), 
                velocity: (0.0, 0.0, 0.0),
                max_speed: speed,
                max_force: 2.0,
            });
        }
    }
}

fn spawn_anomaly(w: &mut World, anomaly_type: &str, mass: f32, radius: f32, dist: f32) {
    let mut rng = rand::thread_rng();
    let angle = rng.gen_range(0.0..std::f32::consts::TAU);
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
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Snapshot {
    summary: String,
    environment_theme: String,
    terrain_rules: String,
    physics_mode: String,
    camera_zoom: f32,
    entities: Vec<SnapshotEntity>,
}

/// Captures all current entities + WorldState and writes world_snap.json
fn save_world_to_disk(
    world: &mut World,
    state: &Arc<Mutex<WorldState>>,
) -> Result<(), String> {
    let ws = state.lock().map_err(|e| format!("Lock error: {}", e))?;

    let mut entities = Vec::new();
    let mut query = world.query::<(&EntityType, &Transform, &PhysicsType)>();
    for (ent_type, transform, phys) in query.iter(world) {
        entities.push(SnapshotEntity {
            ent_type: ent_type.0.clone(),
            transform: transform.clone(),
            physics_type: phys.clone(),
        });
    }

    let snapshot = Snapshot {
        summary: ws.summary.clone(),
        environment_theme: ws.environment_theme.clone(),
        terrain_rules: ws.terrain_rules.clone(),
        physics_mode: ws.physics_mode.clone(),
        camera_zoom: ws.camera_zoom,
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
    pub gravity: f32,
    pub player_speed: f32,
    pub friction: f32,
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
    // Option<(f32, f32)> = None means "no override pending".
    let player_target: Arc<Mutex<Option<(f32, f32)>>> = Arc::new(Mutex::new(None));

    let world = Arc::new(Mutex::new(World::new()));
    {
        let mut w = world.lock().unwrap();
        w.insert_resource(SharedState(state.clone()));

        // --- THE PLAYER ---
        w.spawn((
            EntityType("player".to_string()),
            Transform { x: 500.0, y: 0.0, z: 0.0, rotation: 0.0 }, // Start near Earth
            PhysicsType::Static,
            Health { max: 100.0, current: 100.0 },
            Visuals { model_type: Some("ufo".to_string()), color: "cyan".to_string() },
            WeaponParameters {
                projectile_count: 1,
                projectile_color: "#ef4444".to_string(),
                spread: 0.15,
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
                radius: 300.0, // Rescaled Sun
            },
            components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
        ));

        // 2. THE PLANETS: Condense for Phase 6.4 (1 AU = 1,000 units, Max 30,000)
        let planet_configs = vec![
            ("Mercury", 400.0,   0.8, 40.0),
            ("Venus",   700.0,   0.6, 85.0),
            ("Earth",   1000.0,  0.4, 100.0),
            ("Mars",    1500.0,  0.35, 60.0),
            ("Jupiter", 5000.0,  0.2, 250.0),
            ("Saturn",  9000.0,  0.15, 210.0),
            ("Uranus",  17000.0, 0.1, 140.0),
            ("Neptune", 30000.0, 0.08, 130.0),
        ];

        for (name, dist, speed, size) in planet_configs {
            let angle = rand::thread_rng().gen_range(0.0..std::f32::consts::TAU);
            let planet_id = w.spawn((
                EntityType("planet".to_string()),
                Name(name.to_string()),
                Transform { 
                    x: angle.cos() * dist, 
                    y: angle.sin() * dist, 
                    z: 0.0, 
                    rotation: 0.0 
                },
                PhysicsType::Orbital { radius: dist, speed, angle },
                components::SpatialAnomaly {
                    anomaly_type: "planet".to_string(),
                    mass: 0.0,
                    radius: size, 
                },
                components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
            )).id().index();

            // --- MOON SPANNING (Rescaled) ---
            match name {
                "Earth" => {
                    w.spawn((
                        EntityType("moon".to_string()),
                        Name("Luna".to_string()),
                        Transform { x: 250.0, y: 0.0, z: 0.0, rotation: 0.0 },
                        PhysicsType::Orbital { radius: 250.0, speed: 1.02, angle: 0.0 },
                        components::SpatialAnomaly { anomaly_type: "moon".to_string(), mass: 0.0, radius: 25.0 },
                        Parent(planet_id),
                        Visuals { model_type: Some("sphere".to_string()), color: "#a8a8a8".to_string() }
                    ));
                },
                "Mars" => {
                    w.spawn((EntityType("moon".to_string()), Name("Phobos".to_string()), Transform { x: 120.0, y: 0.0, z: 0.0, rotation: 0.0 }, PhysicsType::Orbital { radius: 120.0, speed: 2.14, angle: 0.5 }, components::SpatialAnomaly { anomaly_type: "moon".to_string(), mass: 0.0, radius: 15.0 }, Parent(planet_id), Visuals { model_type: Some("asteroid".to_string()), color: "#5c534b".to_string() }));
                    w.spawn((EntityType("moon".to_string()), Name("Deimos".to_string()), Transform { x: 200.0, y: 0.0, z: 0.0, rotation: 0.0 }, PhysicsType::Orbital { radius: 200.0, speed: 1.35, angle: 2.1 }, components::SpatialAnomaly { anomaly_type: "moon".to_string(), mass: 0.0, radius: 12.0 }, Parent(planet_id), Visuals { model_type: Some("asteroid".to_string()), color: "#8c7e71".to_string() }));
                },
                "Jupiter" => {
                    w.spawn((EntityType("moon".to_string()), Name("Io".to_string()), Transform { x: 450.0, y: 0.0, z: 0.0, rotation: 0.0 }, PhysicsType::Orbital { radius: 450.0, speed: 1.73, angle: 0.0 }, components::SpatialAnomaly { anomaly_type: "moon".to_string(), mass: 0.0, radius: 35.0 }, Parent(planet_id), Visuals { model_type: Some("sphere".to_string()), color: "#e6c13e".to_string() }));
                    w.spawn((EntityType("moon".to_string()), Name("Europa".to_string()), Transform { x: 600.0, y: 0.0, z: 0.0, rotation: 0.0 }, PhysicsType::Orbital { radius: 600.0, speed: 1.37, angle: 1.2 }, components::SpatialAnomaly { anomaly_type: "moon".to_string(), mass: 0.0, radius: 30.0 }, Parent(planet_id), Visuals { model_type: Some("sphere".to_string()), color: "#c2b19f".to_string() }));
                },
                "Saturn" => {
                    w.spawn((EntityType("moon".to_string()), Name("Titan".to_string()), Transform { x: 700.0, y: 0.0, z: 0.0, rotation: 0.0 }, PhysicsType::Orbital { radius: 700.0, speed: 0.56, angle: 3.1 }, components::SpatialAnomaly { anomaly_type: "moon".to_string(), mass: 0.0, radius: 60.0 }, Parent(planet_id), Visuals { model_type: Some("sphere".to_string()), color: "#d19b45".to_string() }));
                },
                _ => {}
            }
        }

        // 3. SCATTERED ASTEROIDS (Requirement 3)
        let mut rng = rand::thread_rng();
        for _ in 0..200 {
            let x = rng.gen_range(-30000.0..30000.0);
            let y = rng.gen_range(-30000.0..30000.0);
            w.spawn((
                EntityType("asteroid".to_string()),
                Transform { x, y, z: 0.0, rotation: rng.gen_range(0.0..std::f32::consts::TAU) },
                PhysicsType::Static,
                components::SpatialAnomaly { anomaly_type: "asteroid".to_string(), mass: 0.0, radius: rng.gen_range(50.0..150.0) },
                components::PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
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

    let update_state = warp::post()
        .and(warp::path("state"))
        .and(warp::body::json())
        .and(state_filter.clone())
        .and(warp::any().map(move || clients_for_state.clone()))
        .and(warp::any().map(move || player_target_for_state.clone()))
        .and(warp::any().map(move || reality_for_state.clone()))
        .map(|new_state: WorldState, state: Arc<Mutex<WorldState>>, _clients: Clients, pt: Arc<Mutex<Option<(f32, f32)>>>, rm: Arc<Mutex<RealityModifiers>>| {
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
    let save_route = warp::post()
        .and(warp::path("save"))
        .map(move || {
            let mut w = world_for_save.lock().unwrap();
            match save_world_to_disk(&mut w, &state_for_save) {
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
                } else {
                    w.entity_mut(e).insert(Visuals {
                        model_type: Some(req.model_type.unwrap_or_else(|| "ufo".to_string())),
                        color: req.color.unwrap_or_else(|| "white".to_string()),
                    });
                }
            }
            warp::reply::json(&serde_json::json!({ "status": "updated_player" }))
        });

    // POST /api/engine/reset — Globally clear overrides and modifiers
    let world_for_reset = world.clone();
    let reality_for_reset = reality_modifiers.clone();
    let reset_route = warp::post()
        .and(warp::path!("api" / "engine" / "reset"))
        .map(move || {
            // 1. Reset Global Reality Modifiers
            {
                let mut rm = reality_for_reset.lock().unwrap();
                *rm = RealityModifiers::default();
            }

            // 2. Clear Player Visual Overrides & Component Data
            let mut w = world_for_reset.lock().unwrap();
            let mut query = w.query::<(Entity, &EntityType, Option<&mut Visuals>, Option<&mut WeaponParameters>)>();
            for (_entity, ent_type, visuals_opt, weapon_opt) in query.iter_mut(&mut w) {
                if ent_type.0 == "player" {
                    if let Some(mut v) = visuals_opt {
                        v.model_type = None; // Reset to default (handled by rendering)
                        v.color = "#ffffff".to_string(); // Reset to default color
                    }
                    if let Some(mut wp) = weapon_opt {
                        *wp = WeaponParameters::default();
                    }
                }
            }
            
            warp::reply::json(&serde_json::json!({ "status": "Engine Defaults Restored" }))
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
                let mut player_query = w.query::<(Entity, &EntityType)>();
                let mut player_entity = None;
                for (e, etype) in player_query.iter(&w) {
                    if etype.0 == "player" {
                        player_entity = Some(e);
                        break;
                    }
                }
                
                if let Some(e) = player_entity {
                    if let Some(mut weapon) = w.get_mut::<WeaponParameters>(e) {
                        if let Some(cnt) = req.projectile_count { weapon.projectile_count = cnt; }
                        if let Some(clr) = req.projectile_color { weapon.projectile_color = clr; }
                        if let Some(spr) = req.spread { weapon.spread = spr; }
                    } else {
                        w.entity_mut(e).insert(WeaponParameters {
                            projectile_count: req.projectile_count.unwrap_or(1),
                            projectile_color: req.projectile_color.unwrap_or_else(|| "#00ff00".to_string()),
                            spread: req.spread.unwrap_or(0.1),
                        });
                    }
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

    let routes = get_state_route.or(update_state).or(save_route).or(spawn_route).or(clear_route).or(despawn_route).or(modify_route).or(update_player_route).or(command_route).or(next_level_route).or(reset_route).with(state_cors);
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
    
    // ---------- Survival State ----------
    // Player health (0–100). Tracked outside ECS for easy cross-scope access.
    let player_health: Arc<Mutex<f32>> = Arc::new(Mutex::new(100.0));
    // Invincibility window after a hit (seconds). Prevents one-frame death spiral.
    let damage_cooldown: Arc<Mutex<f32>> = Arc::new(Mutex::new(0.0));
    // Knockback velocity applied to the player on hit, decays each frame.
    let player_knockback: Arc<Mutex<(f32, f32)>> = Arc::new(Mutex::new((0.0, 0.0)));
    // Cumulative kill count broadcast to React.
    let total_kills: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
    let total_enemy_kills: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
    let total_asteroid_kills: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
    // Time tracking for survival levels
    let level_start_time: Arc<Mutex<std::time::Instant>> = Arc::new(Mutex::new(std::time::Instant::now()));
    // > 0.0 means the player is dead; counts down 3 s then resets.
    let game_over_timer: Arc<Mutex<f32>> = Arc::new(Mutex::new(0.0));

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
    let mut current_level: u32 = 1;
    let mut kills_at_level_start: u32 = 0;
    let mut enemy_kills_at_level_start: u32 = 0;
    let mut asteroid_kills_at_level_start: u32 = 0;
    let mut print_counter: u64 = 0;
    let mut last_shot_time = std::time::Instant::now();

    loop {
        let mut success_kill_this_frame = false;
        if print_counter == 0 { println!("  [TICK START]"); }
        
        // Evaluate input for this frame (Rotational Steering)
        let (mut turn_dir, mut thrust, shoot) = {
            if print_counter == 0 { println!("  locking player_input_state..."); }
            let state = player_input_state.lock().unwrap();
            let mut td: f32 = 0.0;
            let mut th: f32 = 0.0;
            if state.up { th += 1.0; }     // Forward thrust
            if state.down { th -= 0.5; }   // Minor reverse thrust
            if state.left { td -= 1.0; }   // Turn left
            if state.right { td += 1.0; }  // Turn right
            (td, th, state.shoot)
        };

        if print_counter == 0 { println!("  locking game_over_timer..."); }
        let is_game_over_this_frame = *game_over_timer_for_loop.lock().unwrap() > 0.0;
        if is_game_over_this_frame {
            turn_dir = 0.0;
            thrust = 0.0;
        }
        let shoot = shoot && !is_game_over_this_frame;

        if print_counter == 0 { println!("  locking player_knockback..."); }
        let knockback = {
            let mut kb = player_knockback_for_loop.lock().unwrap();
            let v = *kb;
            kb.0 *= 0.82; // ~18-frame decay at 60 fps
            kb.1 *= 0.82;
            v
        };

        let mut projectiles_to_spawn = Vec::new(); // (x, y, rot, color, Option<target_lock_id>)

        let (speed_multiplier, gravity_mod, friction_mod) = {
            let rm = reality_for_sys.lock().unwrap();
            (rm.player_speed, rm.gravity, rm.friction)
        };

        {
            if print_counter == 0 { println!("  locking world..."); }
            let mut w = world.lock().unwrap();
            
            if print_counter == 0 { println!("  locking reality_for_sys (write resource)..."); }
            w.insert_resource(systems::RealityModifiersRes { 
                gravity: gravity_mod, 
                friction: friction_mod 
            });
            
            if print_counter == 0 { println!("  running schedule..."); }
            schedule.run(&mut w);

            // --- HARD COLLISIONS (Requirement 2): Pre-collect planetary bodies & Moons ---
            let mut planetary_bodies = Vec::new();
            {
                let mut collision_query = w.query::<(Entity, &EntityType, &Transform, &components::SpatialAnomaly, Option<&Parent>)>();
                // First pass: find planet positions
                let mut planet_world_pos = std::collections::HashMap::new();
                for (ent, etype, trans, _, _) in collision_query.iter(&w) {
                    if etype.0 == "planet" || etype.0 == "sun" {
                        planet_world_pos.insert(ent.index(), (trans.x, trans.y));
                    }
                }
                // Second pass: compute global collision positions
                for (_ent, etype, trans, anomaly, parent_opt) in collision_query.iter(&w) {
                    if etype.0 == "sun" || etype.0 == "planet" {
                        planetary_bodies.push((trans.x, trans.y, anomaly.radius));
                    } else if etype.0 == "moon" {
                        if let Some(p) = parent_opt {
                            if let Some((px, py)) = planet_world_pos.get(&p.0) {
                                // Moon position is local to planet in physics
                                planetary_bodies.push((px + trans.x, py + trans.y, anomaly.radius));
                            }
                        }
                    }
                }
            }

            if print_counter == 0 { println!("  locking player_target..."); }
            let maybe_target = *player_target_for_loop.lock().unwrap();
            
            if print_counter == 0 { println!("  process player movement..."); }
            
            // Collect player data once to move collision logic to a unified block
            let mut p_x = 0.0;
            let mut p_y = 0.0;
            let mut p_rot = 0.0;
            let mut ent_player = Entity::from_raw(0); // placeholder
            let mut move_processed = false;

            {
                let mut player_query = w.query::<(Entity, &EntityType, &mut Transform)>();
                for (entity, ent_type, mut transform) in player_query.iter_mut(&mut w) {
                    if ent_type.0 == "player" {
                        ent_player = entity;
                        // 1. Calculate DESIRED next position (Manual or AI)
                        let mut next_x = transform.x;
                        let mut next_y = transform.y;
                        let mut next_rot = transform.rotation;

                        if turn_dir != 0.0 || thrust != 0.0 {
                            // Manual Pilot: Smooth Rotational Steering
                            next_rot += turn_dir * 3.5 * 0.016; // Turn speed: 3.5 radians/sec
                            next_x += next_rot.cos() * thrust * 1500.0 * speed_multiplier * 0.016;
                            next_y += next_rot.sin() * thrust * 1500.0 * speed_multiplier * 0.016;
                        } else if let Some((tx, ty)) = maybe_target {
                            // AI Pilot Lerp
                            next_x += (tx - transform.x) * 0.12;
                            next_y += (ty - transform.y) * 0.12;
                            if (tx - transform.x).abs() < 2.0 && (ty - transform.y).abs() < 2.0 {
                                next_x = tx;
                                next_y = ty;
                                *player_target_for_loop.lock().unwrap() = None;
                            }
                        }

                        // Apply knockback if any
                        next_x += knockback.0 * 0.016;
                        next_y += knockback.1 * 0.016;

                        // 2. GLOBAL HARD COLLISIONS (Requirement 1)
                        for (ox, oy, oradius) in &planetary_bodies {
                            let dx = next_x - ox;
                            let dy = next_y - oy;
                            let dist_sq = dx * dx + dy * dy;
                            let ship_radius = 20.0; // Slightly larger ship collision
                            let combined_radius = oradius + ship_radius;
                            
                            if dist_sq < combined_radius * combined_radius {
                                let dist = dist_sq.sqrt();
                                let overlap = combined_radius - dist;
                                let nx = dx / dist;
                                let ny = dy / dist;
                                
                                next_x += nx * overlap;
                                next_y += ny * overlap;
                            }
                        }

                        // 3. Finalize Transform
                        transform.x = next_x;
                        transform.y = next_y;
                        transform.rotation = next_rot;

                        p_x = transform.x;
                        p_y = transform.y;
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
                let mut min_dist_sq = std::f32::MAX;
                for (t_e, t_t, t_type, death_age) in target_query.iter(&w) {
                    if death_age.is_none() && (t_type.0 == "enemy" || t_type.0 == "asteroid") {
                        let dx = p_x - t_t.x;
                        let dy = p_y - t_t.y;
                        let dist_sq = dx*dx + dy*dy;
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

            if shoot && move_processed && last_shot_time.elapsed().as_secs_f32() > 0.15 {
                let wp = w.get::<WeaponParameters>(ent_player).cloned().unwrap_or(WeaponParameters {
                    projectile_count: 1,
                    projectile_color: "#ef4444".to_string(),
                    spread: 0.15,
                });

                for i in 0..wp.projectile_count {
                    let mut offset_angle = 0.0;
                    if wp.projectile_count > 1 {
                        offset_angle = (i as f32 - (wp.projectile_count as f32 - 1.0) / 2.0) * wp.spread;
                    }
                    let final_rot = p_rot + offset_angle;
                    // Strict Nose Alignment: spawn at nose (r=25) with direction-aligned velocity
                    let nose_dist = 25.0;
                    projectiles_to_spawn.push((
                        p_x + final_rot.cos() * nose_dist,
                        p_y + final_rot.sin() * nose_dist,
                        final_rot,
                        wp.projectile_color.clone(),
                        current_target_lock
                    ));
                }
                last_shot_time = std::time::Instant::now(); // Track shot time
            }

            // --- AGGRO AI (Requirement 3) ---
            {
                let mut enemy_query = w.query::<(&EntityType, &mut Transform, &mut components::SteeringAgent, Option<&DeathAge>)>();
                for (et, mut t, mut agent, death_age) in enemy_query.iter_mut(&mut w) {
                    if death_age.is_none() && et.0 == "enemy" {
                        let dx = p_x - t.x;
                        let dy = p_y - t.y;
                        let dist_sq = dx * dx + dy * dy;
                        if dist_sq < 16_000_000.0 { // 4000.0 squared
                            agent.behavior = "attack".to_string();
                            t.rotation = dy.atan2(dx); // Face player
                            if rand::random::<f32>() < 0.015 { // ~1 shot per sec
                                projectiles_to_spawn.push((t.x, t.y, t.rotation, "enemy".to_string(), Some(ent_player.index())));
                            }
                        } else {
                            // If they are far away, return to idle
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
                    proj.lifespan -= 0.016;
                    
                    // --- HUNTER'S EYE HOMING ---
                    if let Some(lock) = lock_opt {
                        if let Some(&(tx, ty)) = target_positions.get(&lock.0) {
                            let speed = (proj.velocity.0 * proj.velocity.0 + proj.velocity.1 * proj.velocity.1).sqrt();
                            let current_angle = proj.velocity.1.atan2(proj.velocity.0);
                            let target_angle = (ty - p_trans.y).atan2(tx - p_trans.x);
                            
                            // Interpolate angle (max turn speed 0.06 radians per frame)
                            let mut diff = target_angle - current_angle;
                            while diff > std::f32::consts::PI { diff -= 2.0 * std::f32::consts::PI; }
                            while diff < -std::f32::consts::PI { diff += 2.0 * std::f32::consts::PI; }
                            
                            let new_angle = current_angle + diff.clamp(-0.06, 0.06);
                            proj.velocity.0 = speed * new_angle.cos();
                            proj.velocity.1 = speed * new_angle.sin();
                            p_trans.rotation = new_angle; // Update visual rotation
                        }
                    }

                    p_trans.x += proj.velocity.0 * 0.016;
                    p_trans.y += proj.velocity.1 * 0.016;
                    
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
            let mut projectiles_info: Vec<(Entity, f32, f32)> = Vec::new();
            {
                let mut p_query = w.query::<(Entity, &Transform, &Projectile)>();
                for (entity, t, _) in p_query.iter(&mut w) {
                    projectiles_info.push((entity, t.x, t.y));
                }
            }

            let mut target_info: Vec<(Entity, f32, f32, String)> = Vec::new();
            {
                let mut target_query = w.query_filtered::<(Entity, &Transform, &EntityType, Option<&DeathAge>), Without<Projectile>>();
                for (entity, t, ent_type, death_age) in target_query.iter(&mut w) {
                    if death_age.is_none() && (ent_type.0 == "star" || ent_type.0 == "companion" || ent_type.0 == "enemy" || ent_type.0 == "asteroid") {
                        target_info.push((entity, t.x, t.y, ent_type.0.clone()));
                    }
                }
            }

            let mut combat_kills = 0;
            let mut enemy_kills_this_frame = 0;
            let mut asteroid_kills_this_frame = 0;
            let mut explosions_to_spawn: Vec<(f32, f32)> = Vec::new(); // Queue for new 3D explosion entities
            let mut to_kill: Vec<Entity> = Vec::new(); // Queue for entity destruction

            for (p_entity, px, py) in projectiles_info {
                for (t_entity, tx, ty, t_type) in &target_info {
                    let dx = px - tx;
                    let dy = py - ty;
                    if (dx*dx + dy*dy).sqrt() < 30.0 { // 30px collision radius
                        to_kill.push(p_entity); // Destroy projectile
                        to_kill.push(*t_entity); // Destroy target
                        explosions_to_spawn.push((*tx, *ty)); // Add to explosion queue
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
                let mut faction_entities: Vec<(Entity, f32, f32, String)> = Vec::new();
                {
                    let mut fq = w.query_filtered::<(Entity, &Transform, &Faction, &EntityType, Option<&DeathAge>), Without<Projectile>>();
                    for (entity, t, faction, ent_type, death_age) in fq.iter(&w) {
                        if death_age.is_none() && ent_type.0 != "player" && ent_type.0 != "planet" && ent_type.0 != "sun" {
                            faction_entities.push((entity, t.x, t.y, faction.0.clone()));
                        }
                    }
                }

                let mut faction_kills = 0u32;
                let mut already_killed = std::collections::HashSet::new();
                for i in 0..faction_entities.len() {
                    if already_killed.contains(&faction_entities[i].0) { continue; }
                    for j in (i + 1)..faction_entities.len() {
                        if already_killed.contains(&faction_entities[j].0) { continue; }
                        let (_, ax, ay, ref af) = faction_entities[i];
                        let (_, bx, by, ref bf) = faction_entities[j];
                        // Check hostility: pirate <-> federation
                        let hostile = (af == "pirate" && bf == "federation") || (af == "federation" && bf == "pirate");
                        if !hostile { continue; }
                        let dx = ax - bx;
                        let dy = ay - by;
                        if dx * dx + dy * dy < 900.0 { // 30px squared
                            to_kill.push(faction_entities[i].0);
                            to_kill.push(faction_entities[j].0);
                            explosions_to_spawn.push((ax, ay));
                            explosions_to_spawn.push((bx, by));
                            already_killed.insert(faction_entities[i].0);
                            already_killed.insert(faction_entities[j].0);
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
                    let (px, py) = {
                        let mut pq = w.query::<(&EntityType, &Transform)>();
                        let mut pos = (0.0_f32, 0.0_f32);
                        for (et, t) in pq.iter(&w) {
                            if et.0 == "player" { pos = (t.x, t.y); break; }
                        }
                        pos
                    };

                    // Step 2: collect hostile entities in collision range
                    // Federation entities do NOT damage the player.
                    let mut hostile_hits: Vec<Entity> = Vec::new();
                    let mut hit_dir = (0.0_f32, 0.0_f32);
                    {
                        let mut hq = w.query::<(Entity, &Transform, &EntityType, Option<&DeathAge>, Option<&Faction>)>();
                        for (e, t, et, da, faction_opt) in hq.iter(&w) {
                            if da.is_some() { continue; }
                            if et.0 == "enemy" || et.0 == "asteroid" {
                                // Skip federation entities — they are allies
                                if let Some(f) = faction_opt {
                                    if f.0 == "federation" { continue; }
                                }
                                let dx = px - t.x;
                                let dy = py - t.y;
                                let dist = (dx * dx + dy * dy).sqrt();
                                if dist < 42.0 {
                                    if hit_dir == (0.0, 0.0) {
                                        let d = dist.max(1.0);
                                        hit_dir = (dx / d, dy / d);
                                    }
                                    hostile_hits.push(e);
                                }
                            }
                        }
                    }

                    if !hostile_hits.is_empty() {
                        // Apply damage and invincibility window
                        let new_health = {
                            let mut h = player_health_for_loop.lock().unwrap();
                            *h = (*h - 20.0).max(0.0);
                            *h
                        };
                        *damage_cooldown_for_loop.lock().unwrap() = 1.0; // 1-second invincibility
                        *player_knockback_for_loop.lock().unwrap() = (hit_dir.0 * 520.0, hit_dir.1 * 520.0);

                        // Trigger Shatter Engine on the colliding hostile(s)
                        for e in &hostile_hits {
                            if let Some(mut em) = w.get_entity_mut(*e) {
                                em.insert(DeathAge(0.0));
                            }
                        }

                        // Game Over condition
                        if new_health <= 0.0 {
                            *game_over_timer_for_loop.lock().unwrap() = 3.0;

                            // Shatter the Player visually — spawn golden explosion particles
                            let mut rng = rand::thread_rng();
                            for _ in 0..35 {
                                let angle = rng.gen_range(0.0..std::f32::consts::TAU);
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
            for (ex, ey) in explosions_to_spawn {
                w.spawn((
                    EntityType("explosion".to_string()),
                    Transform { x: ex, y: ey, z: 0.0, rotation: 0.0 },
                    SpawnAge(0.0), // TTL = 0.5 enforced in age tick
                    Visuals { model_type: Some("sphere".to_string()), color: "#f59e0b".to_string() }
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
            for (px, py, prot, pcolor, target_lock) in projectiles_to_spawn {
                let speed = 2500.0;
                let mut ent = w.spawn((
                    EntityType("projectile".to_string()),
                    Transform { x: px, y: py, z: 0.0, rotation: prot },
                    Projectile {
                        velocity: (prot.cos() * speed, prot.sin() * speed, 0.0),
                        lifespan: 1.5,
                        color: pcolor,
                    },
                    PhysicsType::Projectile { speed: 40.0 },
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

        {
            let mut w = world.lock().unwrap();
            
            let mut p_pos = (0.0, 0.0);
            let mut mars_pos = (std::f32::MAX, std::f32::MAX);
            let mut jup_pos = (std::f32::MAX, std::f32::MAX);
            
            {
                let mut tq = w.query::<(&EntityType, Option<&Name>, &Transform)>();
                for (et, name, t) in tq.iter(&w) {
                    if et.0 == "player" { p_pos = (t.x, t.y); }
                    if let Some(n) = name {
                        if n.0 == "Mars" { mars_pos = (t.x, t.y); }
                        if n.0 == "Jupiter" { jup_pos = (t.x, t.y); }
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
                let enemy_count = (current_level as usize * 2) + 1;
                let range = (3000.0 + (current_level as f32 * 500.0), 6000.0 + (current_level as f32 * 1000.0));
                spawn_wave(&mut w, enemy_count, "pirate", "enemy", range);
                
                kills_at_level_start = current_score;
                enemy_kills_at_level_start = current_enemy_kills;
                asteroid_kills_at_level_start = current_asteroid_kills;
                *level_start_time_for_loop.lock().unwrap() = std::time::Instant::now();
            }
        }
        
        let mut entities_data: Vec<EntityData> = Vec::new();
        let mut particles_data: Vec<ParticleData> = Vec::new();
        let mut player_pos = (0.0_f32, 0.0_f32);

        // First pass: collect all entity data and find player position
        {
            let mut w = world.lock().unwrap();
            let mut query = w.query::<(Entity, &Transform, &EntityType, Option<&Name>, Option<&PhysicsType>, Option<&BirthAge>, Option<&DeathAge>, Option<&components::SteeringAgent>, Option<&components::SpatialAnomaly>, Option<&Projectile>, Option<&Faction>, Option<&Visuals>, Option<&Parent>, Option<&SpawnAge>, Option<&components::PersistentId>)>();
            for (entity, transform, ent_type, name, phys_type, birth_age, death_age, steering, anomaly, _projectile, faction_opt, visuals, parent_opt, spawn_age_opt, persistent_id_opt) in query.iter(&w) {
                let speed: f32 = match phys_type {
                    Some(PhysicsType::Orbital { speed, .. }) => *speed,
                    Some(PhysicsType::Sinusoidal { frequency, .. }) => *frequency * 0.3,
                    Some(PhysicsType::Projectile { speed }) => *speed,
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

                // Color is determined by speed in React, keep legacy color for non-stars
                let color = match ent_type.0.as_str() {
                    "player"     => "player",
                    "companion"  => "companion",
                    "star"       => "star",
                    "anomaly"    => "anomaly",
                    "projectile" => "projectile",
                    _            => "other",
                };

                if let Some(v) = visuals {
                    model_type = v.model_type.clone();
                    custom_color = Some(v.color.clone());
                }

                if ent_type.0 == "player" {
                    player_pos = (transform.x, transform.y);
                }
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
                    name: name.map(|n| n.0.clone()),
                    radius: match ent_type.0.as_str() {
                        "sun"    => Some(120.0),
                        "planet" => Some(anomaly.map_or(20.0, |a| a.radius)), // Fallback or anomaly-stored size
                        _        => None,
                    },
                    anomaly_type,
                    anomaly_radius,
                    model_type,
                    custom_color,
                    parent_id: parent_opt.map(|p| p.0),
                    spawn_age: spawn_age_opt.map(|s| s.0),
                    persistent_id: persistent_id_opt.map(|p| p.0),
                    target_lock_id: w.get::<components::TargetLock>(entity).map(|l| l.0),
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

        // Collision detection: broadcast collision_event for any star within 20px of player
        let collision_clients = clients.clone();
        for ent in &entities_data {
            if ent.ent_type == "star" {
                let dx = player_pos.0 - ent.x;
                let dy = player_pos.1 - ent.y;
                let d = (dx * dx + dy * dy).sqrt();
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

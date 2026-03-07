use crate::components::*;
use crate::GLOBAL_ENTITY_ID;
use bevy_ecs::prelude::*;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

pub const MAX_WORLD_RADIUS: f64 = 64000.0;
// ---------- Helpers for Level Progression ----------
pub fn spawn_wave(
    w: &mut World,
    count: usize,
    faction: &str,
    ent_type: &str,
    dist_range: (f64, f64),
    variant: u32,
) {
    let mut rng = rand::thread_rng();
    for _ in 0..count {
        let radius = rng.gen_range(dist_range.0..dist_range.1);
        let angle = rng.gen_range(0.0..std::f64::consts::TAU);
        let speed = rng.gen_range(20.0..60.0);

        // Per-tier weapon and visual parameters
        let (proj_color, proj_size, proj_count, proj_spread) = match variant {
            2 => ("#aa44ff".to_string(), 16.0_f64, 3_u32, 0.35_f64), // Mothership: violet bursts
            1 => ("#00ff88".to_string(), 10.0_f64, 2_u32, 0.20_f64), // Ravager: twin green bolts
            _ => ("#ff3333".to_string(), 6.0_f64, 1_u32, 0.10_f64),  // Swarmer: single red shot
        };

        let mut ent_mut = w.spawn((
            EntityType(ent_type.to_string()),
            Transform {
                x: angle.cos() * radius,
                y: rng.gen_range(-200.0..200.0),
                z: angle.sin() * radius,
                rotation: angle,
            },
            PhysicsType::Orbital {
                radius,
                speed: rng.gen_range(0.5..1.5),
                angle,
            },
            BirthAge(0.0),
            Faction(faction.to_string()),
            PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
            Visuals {
                model_type: None,
                color: if variant == 2 {
                    "#a855f7"
                } else if variant == 1 {
                    "#10b981"
                } else {
                    "#ef4444"
                }
                .to_string(),
                is_cloaked: false,
            },
            ModelVariant(variant),
            Scale(if variant == 2 {
                6.0
            } else if variant == 1 {
                3.0
            } else {
                2.0
            }), // 2× larger
            Health {
                max: if variant == 2 {
                    500.0
                } else if variant == 1 {
                    150.0
                } else {
                    40.0
                },
                current: if variant == 2 {
                    500.0
                } else if variant == 1 {
                    150.0
                } else {
                    40.0
                },
            },
        ));

        if ent_type == "enemy" || ent_type == "companion" {
            ent_mut.insert(SteeringAgent {
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

pub fn spawn_anomaly(w: &mut World, anomaly_type: &str, mass: f64, radius: f64, dist: f64) {
    let mut rng = rand::thread_rng();
    let angle = rng.gen_range(0.0..std::f64::consts::TAU);
    w.spawn((
        EntityType("anomaly".to_string()),
        Transform {
            x: angle.cos() * dist,
            y: angle.sin() * dist,
            z: 0.0,
            rotation: 0.0,
        },
        PhysicsType::Static,
        SpatialAnomaly {
            anomaly_type: anomaly_type.to_string(),
            mass,
            radius,
        },
        PersistentId(GLOBAL_ENTITY_ID.fetch_add(1, Ordering::SeqCst)),
    ));
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SnapshotEntity {
    pub ent_type: String,
    pub transform: Transform,
    pub physics_type: PhysicsType,
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
pub struct Snapshot {
    pub summary: String,
    pub environment_theme: String,
    pub terrain_rules: String,
    pub physics_mode: String,
    pub camera_zoom: f64,
    pub player_health: f64,
    pub score: u32,
    pub current_level: u32,
    pub entities: Vec<SnapshotEntity>,
    #[serde(default)]
    pub mission_parameters: Option<MissionParameters>,
    #[serde(default)]
    pub persistent_destroyed_ids: std::collections::HashSet<u64>,
}

/// Captures restorable entities (enemies, companions, alien_ships) + WorldState + player stats
/// and writes world_snap.json next to the project root.
pub fn save_world_to_disk(
    world: &mut World,
    state: &Arc<Mutex<WorldState>>,
    player_health: f64,
    score: u32,
    current_level: u32,
) -> Result<(), String> {
    let ws = state.lock().map_err(|e| format!("Lock error: {}", e))?;

    const SAVEABLE: &[&str] = &["enemy", "alien_ship", "companion", "space_station"];

    let mut entities = Vec::new();
    let mut query = world.query::<(
        &EntityType,
        &Transform,
        &PhysicsType,
        Option<&ModelVariant>,
        Option<&Scale>,
        Option<&Visuals>,
    )>();
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

    let mission_params = world.get_resource::<MissionParameters>().cloned();
    let destroyed_ids = world
        .get_resource::<PersistentWorldState>()
        .map(|p| p.destroyed_ids.clone())
        .unwrap_or_default();

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
        mission_parameters: mission_params,
        persistent_destroyed_ids: destroyed_ids,
    };

    let json =
        serde_json::to_string_pretty(&snapshot).map_err(|e| format!("Serialize error: {}", e))?;

    // Write next to the project root
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("world_snap.json"))
        .unwrap_or_else(|| std::path::PathBuf::from("world_snap.json"));

    let mut file = std::fs::File::create(&path).map_err(|e| format!("File create error: {}", e))?;
    file.write_all(json.as_bytes())
        .map_err(|e| format!("File write error: {}", e))?;

    println!(
        "World snapshot saved to {:?} ({} entities)",
        path,
        snapshot.entities.len()
    );
    Ok(())
}

pub fn rebuild_asteroids(world: &mut World) {
    let params = world
        .get_resource::<MissionParameters>()
        .cloned()
        .unwrap_or_default();
    let persistent = world
        .get_resource::<PersistentWorldState>()
        .cloned()
        .unwrap_or_default();

    println!(
        "[Engine] Rebuilding asteroid field with seed: {}, density: {}",
        params.seed, params.density
    );

    // Clear existing asteroids first
    let mut to_despawn = Vec::new();
    let mut query = world.query::<(Entity, &EntityType)>();
    for (entity, etype) in query.iter(world) {
        if etype.0 == "asteroid" {
            to_despawn.push(entity);
        }
    }
    for e in to_despawn {
        world.despawn(e);
    }

    let mut rng = ChaCha8Rng::seed_from_u64(params.seed);
    let count = (22000.0 * params.density) as usize; // Increased base count for 64k radius

    for i in 0..count {
        let p_id = params.seed * 10000 + i as u64;
        if persistent.destroyed_ids.contains(&p_id) {
            continue;
        }

        // Uniform distribution: radius proportional to sqrt(rng)
        let radius = 2000.0 + (MAX_WORLD_RADIUS - 2000.0) * rng.gen::<f64>().sqrt();
        let angle = rng.gen_range(0.0..std::f64::consts::TAU);
        let x = radius * angle.cos();
        let z = radius * angle.sin();
        let y = rng.gen_range(-3000.0..3000.0); // More volumetric vertical spread

        let scale = rng.gen_range(params.min_scale..params.max_scale);

        world.spawn((
            EntityType("asteroid".to_string()),
            Transform {
                x,
                y,
                z,
                rotation: rng.gen_range(0.0..6.28),
            },
            PhysicsType::Static,
            Scale(scale),
            PersistentId(p_id),
            ModelVariant(rng.gen_range(0..3)),
        ));
    }
}

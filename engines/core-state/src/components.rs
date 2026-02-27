use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};

fn default_zoom() -> f32 { 1.0 }
fn default_rotation() -> f32 { 0.0 }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RealityOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sun_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ambient_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gravity_multiplier: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_speed_multiplier: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub global_friction: Option<f32>,
}

// The core WorldState struct mirroring the Python Director's schema.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct WorldState {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub environment_theme: String,
    #[serde(default)]
    pub terrain_rules: String,
    #[serde(default)]
    pub physics_mode: String,
    #[serde(default)]
    pub camera_zoom: f32,
    /// Optional high-priority player position override from the AI Director.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_x: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_y: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reality_override: Option<RealityOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_spaceship: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behavior_policy: Option<String>,
}

impl Default for WorldState {
    fn default() -> Self {
        Self {
            summary: "Updating...".to_string(),
            environment_theme: "default".to_string(),
            terrain_rules: "standard".to_string(),
            physics_mode: "orbital".to_string(),
            camera_zoom: 1.0,
            player_x: None,
            player_y: None,
            reality_override: None,
            player_spaceship: None,
            behavior_policy: None,
        }
    }
}

// Example ECS Component: Transform
#[derive(Component, Debug, Serialize, Deserialize, Clone)]
pub struct Transform {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    #[serde(default = "default_rotation")]
    pub rotation: f32,
}

#[derive(Debug, Deserialize, Clone)]
pub struct PlayerInputMessage {
    pub msg_type: String,
    pub keys: Vec<String>,
}

#[derive(Component, Debug, Clone, Serialize, Deserialize)]
pub struct Projectile {
    pub velocity: (f32, f32, f32),
    pub lifespan: f32,
    pub color: String,
}

// Example ECS Component: PhysicsType for generative behavior
#[derive(Component, Debug, Serialize, Deserialize, Clone)]
pub enum PhysicsType {
    Static,
    Orbital { radius: f32, speed: f32, angle: f32 },
    Sinusoidal { amplitude: f32, frequency: f32, time: f32 },
}

// Example ECS Component: Type/Name
#[derive(Component, Debug, Serialize, Deserialize, Clone)]
pub struct EntityType(pub String);

#[derive(Component, Debug, Serialize, Deserialize, Clone)]
pub struct Name(pub String);


/// Birth effect timer. Starts at 0.0 on spawn, incremented each game tick (0.016s).
/// Physics system multiplies speed by min(age / 2.0, 1.0) → 0→full over ~2 seconds.
/// Broadcast includes is_newborn: true while age < 2.0.
#[derive(Component, Debug, Clone)]
pub struct BirthAge(pub f32);

/// Death effect timer. Starts at 0.0 when marked for death.
/// Entity shrinks and fades out, then is despawned from ECS when age > 1.0s.
#[derive(Component, Debug, Clone)]
pub struct DeathAge(pub f32);

/// General spawn timer for temporary entities (explosion shells, etc.)
#[derive(Component, Debug, Clone)]
pub struct SpawnAge(pub f32);

/// Autonomous Agent Steering parameters
#[derive(Component, Debug, Clone)]
pub struct SteeringAgent {
    pub behavior: String, // "idle", "swarm", "attack", "protect", "scatter"
    pub velocity: (f32, f32, f32),
    pub max_speed: f32,
    pub max_force: f32,
}

/// A short-lived particle created when an entity shatters.
#[derive(Component, Debug, Clone, Serialize, Deserialize)]
pub struct Particle {
    pub velocity: (f32, f32, f32),
    pub lifespan: f32, // Remaining time in seconds
    pub max_lifespan: f32,
    pub color: String,
}

/// Spatial Anomaly representing gravity wells, repulsors, or black holes.
#[derive(Component, Debug, Clone, Serialize, Deserialize)]
pub struct SpatialAnomaly {
    pub anomaly_type: String, // "black_hole", "repulsor"
    pub mass: f32,
    pub radius: f32,
}

/// Player health — tracks current and maximum hull integrity.
#[derive(Component, Debug, Clone)]
pub struct Health {
    pub max: f32,
    pub current: f32,
}

#[derive(Component, Clone, Debug)]
pub struct Faction(pub String);

/// Hierarchical link: stores the entity ID of the parent planet.
#[derive(Component, Debug, Clone, Serialize, Deserialize)]
pub struct Parent(pub u32);

/// Player visual customization
#[derive(Component, Debug, Clone, Serialize, Deserialize)]
pub struct Visuals {
    pub model_type: String,
    pub color: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePlayerRequest {
    pub model_type: Option<String>,
    pub color: Option<String>,
}

#[derive(Component, Debug, Clone, Serialize, Deserialize)]
pub struct WeaponParameters {
    pub projectile_count: u32,
    pub projectile_color: String,
    pub spread: f32, // Offset between shots in multi-shot
}

#[derive(Component, Debug, Clone, Serialize, Deserialize)]
pub struct PersistentId(pub u64); // Strict unique ID for external AI targeting

#[derive(Debug, Deserialize)]
pub struct CommandRequest {
    pub action: String, // e.g. "set_weapon"
    pub projectile_count: Option<u32>,
    pub projectile_color: Option<String>,
    pub spread: Option<f32>,
}


use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

fn default_zoom() -> f64 {
    1.0
}
fn default_rotation() -> f64 {
    0.0
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RealityOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sun_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ambient_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gravity_multiplier: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_speed_multiplier: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub global_friction: Option<f64>,
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
    pub camera_zoom: f64,
    /// Optional high-priority player position override from the AI Director.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reality_override: Option<RealityOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_spaceship: Option<String>, // Legacy - we might keep or deprecate
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behavior_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ship_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ship_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mission_complete: Option<bool>,

    // AI-Controlled UI & Environment State
    #[serde(default)]
    pub radar_filters: HashMap<String, bool>,
    #[serde(default)]
    pub audio_settings: AudioSettings,
    #[serde(default)]
    pub mission_parameters: Option<MissionParameters>,
}

#[derive(Resource, Debug, Serialize, Deserialize, Clone, Default)]
pub struct AudioSettings {
    pub game_muted: bool,
    pub ai_muted: bool,
}

#[derive(Resource, Debug, Serialize, Deserialize, Clone)]
pub struct MissionParameters {
    pub seed: u64,
    pub density: f64,
    pub min_scale: f64,
    pub max_scale: f64,
}

impl Default for MissionParameters {
    fn default() -> Self {
        Self {
            seed: 42,
            density: 1.0,
            min_scale: 0.5,
            max_scale: 2.5,
        }
    }
}

/// Persistent state to track which unique entities have been destroyed across a session.
#[derive(Resource, Debug, Default, Clone)]
pub struct PersistentWorldState {
    pub destroyed_ids: HashSet<u64>,
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
        }
    }
}

// Example ECS Component: Transform
#[derive(Component, Debug, Serialize, Deserialize, Clone)]
pub struct Transform {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    #[serde(default = "default_rotation")]
    pub rotation: f64,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct PlayerInputMessage {
    #[serde(default)]
    pub msg_type: String,
    #[serde(default, deserialize_with = "deserialize_keys")]
    pub keys: Vec<String>,
    #[serde(default)]
    pub cam_yaw: f64,
    #[serde(default)]
    pub cam_pitch: f64,
}

fn deserialize_keys<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    // Accept both a JSON array and JSON null (treat null as empty)
    let opt: Option<Vec<String>> = Option::deserialize(deserializer)?;
    Ok(opt.unwrap_or_default())
}

#[derive(Component, Debug, Clone, Serialize, Deserialize)]
pub struct Projectile {
    pub velocity: (f64, f64, f64),
    pub lifespan: f64,
    pub color: String,
    #[serde(default = "default_projectile_size")]
    pub size: f64,
    #[serde(default)]
    pub shooter_id: Option<Entity>,
}

// Example ECS Component: PhysicsType for generative behavior
#[derive(Component, Debug, Serialize, Deserialize, Clone)]
pub enum PhysicsType {
    Static,
    Orbital {
        radius: f64,
        speed: f64,
        angle: f64,
    },
    Sinusoidal {
        amplitude: f64,
        frequency: f64,
        time: f64,
    },
    Velocity {
        vx: f64,
        vy: f64,
        vz: f64,
    },
    Projectile {
        speed: f64,
        #[serde(default)]
        pitch_angle: f64,
    },
}

// Example ECS Component: Type/Name
#[derive(Component, Debug, Serialize, Deserialize, Clone)]
pub struct EntityType(pub String);

#[derive(Component, Debug, Serialize, Deserialize, Clone)]
pub struct Name(pub String);

#[derive(Component, Debug, Serialize, Deserialize, Clone)]
pub struct Scale(pub f64);

#[derive(Component, Debug, Serialize, Deserialize, Clone)]
pub struct ModelVariant(pub u32);

/// Birth effect timer. Starts at 0.0 on spawn, incremented each game tick (0.016s).
/// Physics system multiplies speed by min(age / 2.0, 1.0) → 0→full over ~2 seconds.
/// Broadcast includes is_newborn: true while age < 2.0.
#[derive(Component, Debug, Clone)]
pub struct BirthAge(pub f64);

/// Death effect timer. Starts at 0.0 when marked for death.
/// Entity shrinks and fades out, then is despawned from ECS when age > 1.0s.
#[derive(Component, Debug, Clone)]
pub struct DeathAge(pub f64);

/// General spawn timer for temporary entities (explosion shells, etc.)
#[derive(Component, Debug, Clone)]
pub struct SpawnAge(pub f64);

/// Autonomous Agent Steering parameters
#[derive(Component, Debug, Clone)]
pub struct SteeringAgent {
    pub behavior: String, // "idle", "swarm", "attack", "protect", "scatter"
    pub velocity: (f64, f64, f64),
    pub max_speed: f64,
    pub max_force: f64,
}

/// A short-lived particle created when an entity shatters.
#[derive(Component, Debug, Clone, Serialize, Deserialize)]
pub struct Particle {
    pub velocity: (f64, f64, f64),
    pub lifespan: f64, // Remaining time in seconds
    pub max_lifespan: f64,
    pub color: String,
}

/// Spatial Anomaly representing gravity wells, repulsors, or black holes.
#[derive(Component, Debug, Clone, Serialize, Deserialize)]
pub struct SpatialAnomaly {
    pub anomaly_type: String, // "black_hole", "repulsor"
    pub mass: f64,
    pub radius: f64,
}

/// Player health — tracks current and maximum hull integrity.
#[derive(Component, Debug, Clone)]
pub struct Health {
    pub max: f64,
    pub current: f64,
}

#[derive(Component, Clone, Debug)]
pub struct Faction(pub String);

/// Hierarchical link: stores the entity ID of the parent planet.
#[derive(Component, Debug, Clone, Serialize, Deserialize)]
pub struct Parent(pub u32);

/// Player visual customization
#[derive(Component, Debug, Clone, Serialize, Deserialize)]
pub struct Visuals {
    pub model_type: Option<String>,
    pub color: String,
    #[serde(default)]
    pub is_cloaked: bool,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePlayerRequest {
    pub model_type: Option<String>,
    pub color: Option<String>,
    pub is_cloaked: Option<bool>,
}

#[derive(Component, Debug, Clone, Serialize, Deserialize)]
pub struct WeaponParameters {
    pub projectile_count: u32,
    pub projectile_color: String,
    pub spread: f64,
    #[serde(default = "default_projectile_size")]
    pub projectile_size: f64,
}

fn default_projectile_size() -> f64 {
    8.0
}

impl Default for WeaponParameters {
    fn default() -> Self {
        Self {
            projectile_count: 1,
            projectile_color: "#ef4444".to_string(),
            spread: 0.1,
            projectile_size: 8.0,
        }
    }
}

/// Runtime physics constants tunable by the AI Director via POST /api/physics.
#[derive(Resource, Debug, Clone, Serialize, Deserialize)]
pub struct PhysicsConstants {
    /// Multiplier for all gravitational anomaly forces (1.0 = normal).
    pub gravity_scale: f64,
    /// Friction applied each frame to steering-agent velocity (0.95 = normal).
    pub friction: f64,
    /// Speed multiplier for all projectiles (1.0 = normal).
    pub projectile_speed_mult: f64,
}

impl Default for PhysicsConstants {
    fn default() -> Self {
        Self {
            gravity_scale: 1.0,
            friction: 0.95,
            projectile_speed_mult: 1.0,
        }
    }
}

/// Diplomatic affinity matrix between factions.
/// Key: canonical "faction_a:faction_b" (alphabetical). Value: affinity in [-1.0, +1.0].
/// < -0.3 = hostile (attack on sight), -0.3..=0.3 = neutral, > 0.3 = allied.
#[derive(Resource, Debug, Clone, Serialize, Deserialize)]
pub struct FactionRelations {
    pub relations: std::collections::HashMap<String, f64>,
}

impl FactionRelations {
    fn canonical_key(a: &str, b: &str) -> String {
        if a <= b {
            format!("{}:{}", a, b)
        } else {
            format!("{}:{}", b, a)
        }
    }

    pub fn get_affinity(&self, a: &str, b: &str) -> f64 {
        *self
            .relations
            .get(&Self::canonical_key(a, b))
            .unwrap_or(&0.0)
    }

    pub fn set_affinity(&mut self, a: &str, b: &str, affinity: f64) {
        self.relations
            .insert(Self::canonical_key(a, b), affinity.clamp(-1.0, 1.0));
    }

    pub fn are_hostile(&self, a: &str, b: &str) -> bool {
        self.get_affinity(a, b) < -0.3
    }
}

impl Default for FactionRelations {
    fn default() -> Self {
        let mut relations = std::collections::HashMap::new();
        // Default: pirates and federation are enemies
        relations.insert("federation:pirate".to_string(), -1.0);
        Self { relations }
    }
}

#[derive(Component, Debug, Clone, Serialize, Deserialize)]
pub struct PersistentId(pub u64); // Strict unique ID for external AI targeting

#[derive(Component, Debug, Clone, Serialize, Deserialize)]
pub struct TargetLock(pub u32); // Holds the bevy Entity index of the locked target

#[derive(Debug, Deserialize)]
pub struct CommandRequest {
    pub action: String,
    pub entity_id: Option<u32>,
    pub entity_type: Option<String>,
    pub projectile_count: Option<u32>,
    pub projectile_color: Option<String>,
    pub spread: Option<f64>,
    pub projectile_size: Option<f64>,
    pub target_id: Option<u32>,
    // Visual override fields (for set_visuals action)
    #[serde(default)]
    pub model_type: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub is_cloaked: Option<bool>,
}

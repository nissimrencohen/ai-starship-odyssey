use crate::api::*;
use crate::components::*;
use crate::engine_state::EngineState;
use crate::world::*;
use crate::*;
use bevy_ecs::prelude::*;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub async fn run(engine_state: EngineState) {
    let player_target_for_loop = engine_state.player_target;
    let player_health_for_loop = engine_state.player_health;
    let damage_cooldown_for_loop = engine_state.damage_cooldown;
    let player_knockback_for_loop = engine_state.player_knockback;
    let total_kills_for_loop = engine_state.total_kills;
    let total_enemy_kills_for_loop = engine_state.total_enemy_kills;
    let total_asteroid_kills_for_loop = engine_state.total_asteroid_kills;
    let level_start_time_for_loop = engine_state.level_start_time;
    let game_over_timer_for_loop = engine_state.game_over_timer;
    let force_next_level_for_loop = engine_state.force_next_level;
    let do_full_reset_for_loop = engine_state.do_full_reset;
    let override_level_for_loop = engine_state.override_level;
    let current_level_shared_for_loop = engine_state.current_level_shared;
    let level_transition_timer_for_loop = engine_state.level_transition_timer;
    let is_paused_for_loop = engine_state.is_paused;
    let player_input_state = engine_state.player_input_state;
    let reality_for_sys = engine_state.reality_modifiers;
    let world = engine_state.world;
    let state = engine_state.state;
    let clients = engine_state.clients;

    let mut schedule = Schedule::default();
    schedule.add_systems((
        crate::sync_state_system,
        systems::generative_physics_system,
        systems::environmental_physics_system,
        systems::particle_physics_system,
        systems::steering_system,
    ));

    let mut current_level: u32 = 1;
    let mut kills_at_level_start: u32 = 0;
    let mut enemy_kills_at_level_start: u32 = 0;
    let mut asteroid_kills_at_level_start: u32 = 0;
    let mut print_counter: u64 = 0;
    let mut last_shot_time = std::time::Instant::now();
    let mut last_tick_time = std::time::Instant::now();
    // Tracks if the current death was caused by a black hole (persists until resurrection)
    let mut bh_death_active = false;

    loop {
        // Real elapsed time since last tick — capped at 100ms to avoid huge jumps after pauses
        let tick_dt = last_tick_time.elapsed().as_secs_f64().min(0.1);
        last_tick_time = std::time::Instant::now();

        let mut success_kill_this_frame = false;
        if print_counter == 0 {
            println!("  [TICK START]");
        }
        print_counter += 1;

        // --- LEVEL TRANSITION TIMER ---
        let is_transitioning_active = {
            let mut timer = level_transition_timer_for_loop.lock().unwrap();
            if *timer > 0.0 {
                *timer = (*timer - tick_dt).max(0.0);
                true
            } else {
                false
            }
        };

        // Evaluate input for this frame
        let (thrust_forward, thrust_back, cam_yaw, cam_pitch, boost_active, shoot) = {
            let state = player_input_state.lock().unwrap();
            (
                state.up,
                state.down,
                state.cam_yaw,
                state.cam_pitch,
                state.boost,
                state.shoot,
            )
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

        let mut projectiles_to_spawn: Vec<(
            f64,
            f64,
            f64,
            f64,
            f64,
            String,
            f64,
            Option<u32>,
            Option<Entity>,
        )> = Vec::new(); // (x, y, z, yaw, pitch, color, size, target, shooter_id)

        let (_speed_multiplier, gravity_mod, friction_mod) = {
            let rm = reality_for_sys.lock().unwrap();
            (rm.player_speed, rm.gravity, rm.friction)
        };

        {
            let mut w = world.lock().unwrap();

            // --- Check do_full_reset signal (from /api/engine/reset) ---
            let full_reset = {
                let mut flag = do_full_reset_for_loop.lock().unwrap();
                let v = *flag;
                *flag = false;
                v
            };
            if full_reset {
                bh_death_active = false;
                *game_over_timer_for_loop.lock().unwrap() = 0.0;
                current_level = 1;
                kills_at_level_start = 0;
                enemy_kills_at_level_start = 0;
                asteroid_kills_at_level_start = 0;
                *level_start_time_for_loop.lock().unwrap() = std::time::Instant::now();
                // Despawn enemies, companions, projectiles (keep solar system)
                let to_despawn: Vec<Entity> = {
                    let mut q = w.query::<(Entity, &EntityType)>();
                    q.iter(&w)
                        .filter(|(_, et)| {
                            matches!(
                                et.0.as_str(),
                                "enemy" | "alien_ship" | "companion" | "projectile" | "explosion" | "anomaly"
                            )
                        })
                        .map(|(e, _)| e)
                        .collect()
                };
                for e in to_despawn {
                    w.despawn(e);
                }
                // Teleport player to spawn + reset ECS health + remove temp components
                let player_entities: Vec<Entity> = {
                    let mut q = w.query::<(Entity, &EntityType)>();
                    q.iter(&w)
                        .filter(|(_, et)| et.0 == "player")
                        .map(|(e, _)| e)
                        .collect()
                };
                for pe in player_entities {
                    if let Some(mut t) = w.get_mut::<Transform>(pe) {
                        t.x = 8500.0;
                        t.y = 500.0;
                        t.z = 0.0;
                    }
                    if let Some(mut phys) = w.get_mut::<PhysicsType>(pe) {
                        *phys = PhysicsType::Velocity {
                            vx: 0.0,
                            vy: 0.0,
                            vz: 0.0,
                        };
                    }
                    if let Some(mut h) = w.get_mut::<Health>(pe) {
                        h.current = h.max;
                    }
                    if let Some(mut v) = w.get_mut::<Visuals>(pe) {
                        *v = Visuals {
                            model_type: Some("ufo".to_string()),
                            color: "cyan".to_string(),
                            is_cloaked: false,
                        };
                    }
                    if let Some(mut wp) = w.get_mut::<WeaponParameters>(pe) {
                        *wp = WeaponParameters::default();
                    }
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
                friction: friction_mod,
            });
            w.insert_resource(systems::DeltaTime(tick_dt));

            if !*is_paused_for_loop.lock().unwrap() {
                schedule.run(&mut w);

                // --- MOON WORLD-POSITION FIXUP ---
                // The orbital system stores moon transforms as planet-relative offsets (cos(a)*r, sin(a)*r).
                // Here we add the parent planet's world position so moons orbit their planet, not the Sun.
                // Only runs when physics runs — avoids position accumulation bug when paused.
                {
                    let mut planet_positions: std::collections::HashMap<u32, (f64, f64, f64)> =
                        std::collections::HashMap::new();
                    {
                        let mut pq = w.query::<(Entity, &Transform, &EntityType)>();
                        for (entity, t, et) in pq.iter(&w) {
                            if et.0 == "planet" {
                                planet_positions.insert(entity.index(), (t.x, t.y, t.z));
                            }
                        }
                    }
                    {
                        let mut moon_updates: Vec<(Entity, f64, f64, f64)> = Vec::new();
                        {
                            let mut mq = w.query::<(Entity, &Transform, &Parent, &EntityType)>();
                            for (entity, t, parent, et) in mq.iter(&w) {
                                if et.0 == "moon" {
                                    if let Some(&(px, py, pz)) = planet_positions.get(&parent.0) {
                                        moon_updates.push((entity, px + t.x, py, pz + t.z));
                                    }
                                }
                            }
                        }
                        for (entity, wx, wy, wz) in moon_updates {
                            if let Some(mut t) = w.get_mut::<Transform>(entity) {
                                t.x = wx;
                                t.y = wy;
                                t.z = wz;
                            }
                        }
                    }
                }
            }

            // --- HARD COLLISIONS: Pre-collect planetary bodies ---
            let mut planetary_bodies = Vec::new();
            {
                // Use SpatialAnomaly.radius for accurate collision detection (matches visual size)
                for (_, t, e, s, sa_opt) in w
                    .query::<(
                        Entity,
                        &Transform,
                        &EntityType,
                        Option<&components::Scale>,
                        Option<&components::SpatialAnomaly>,
                    )>()
                    .iter(&w)
                {
                    if e.0 == "sun" || e.0 == "planet" || e.0 == "moon" {
                        let r = if e.0 == "sun" {
                            1000.0
                        } else {
                            sa_opt.map_or(150.0, |sa| sa.radius) * s.map_or(1.0, |sc| sc.0)
                        };
                        planetary_bodies.push((t.x, t.y, t.z, r));
                    }
                }
            }

            let _maybe_target = *player_target_for_loop.lock().unwrap();

            let mut p_x = 0.0;
            let mut p_y = 0.0;
            let mut p_alt = 0.0;
            let mut p_rot = 0.0;
            let mut ent_player = Entity::from_raw(0);
            let mut move_processed = false;

            {
                let dt = tick_dt; // Use real tick_dt instead of hardcoded 0.016
                let mut player_query =
                    w.query::<(Entity, &EntityType, &mut Transform, &mut PhysicsType)>();
                for (entity, ent_type, mut transform, mut phys) in player_query.iter_mut(&mut w) {
                    if ent_type.0 == "player" {
                        ent_player = entity;

                        // Ship heading follows camera yaw from mouse
                        transform.rotation = cam_yaw;

                        if let PhysicsType::Velocity {
                            ref mut vx,
                            ref mut vy,
                            ref mut vz,
                        } = *phys
                        {
                            let mut thrust_force = 6000.0; // Increased significantly for snappier flight
                            if boost_active {
                                thrust_force *= 3.0; // Stronger boost
                            }

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
                            // Drag - reduced to allow for longer glides and higher speeds
                            let damping = 0.985;
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
                                    let nx = dx / dist;
                                    let ny = dy / dist;
                                    let nz = dz / dist;
                                    // Push player out smoothly
                                    transform.x += nx * overlap;
                                    transform.y += ny * overlap;
                                    transform.z += nz * overlap;
                                    // Sliding collision: remove only the inward velocity component.
                                    // Lateral velocity is preserved so the ship glides along the surface.
                                    let inward = *vx * nx + *vy * ny + *vz * nz;
                                    if inward < 0.0 {
                                        *vx -= inward * nx;
                                        *vy -= inward * ny;
                                        *vz -= inward * nz;
                                    }
                                }
                            }
                        }
                        // Boundary Clamp (Hard Normalization)
                        let p_dist = (transform.x * transform.x + transform.z * transform.z).sqrt();
                        if p_dist > crate::world::MAX_WORLD_RADIUS {
                            let factor = crate::world::MAX_WORLD_RADIUS / p_dist;
                            transform.x *= factor;
                            transform.z *= factor;

                            // Reset velocity if hitting boundary
                            if let PhysicsType::Velocity {
                                ref mut vx,
                                ref mut vz,
                                ..
                            } = *phys
                            {
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
                        let dist_sq = dx * dx + dz * dz;
                        if dist_sq < min_dist_sq && dist_sq < 9000000.0 {
                            // lock up to 3000px away
                            min_dist_sq = dist_sq;
                            current_target_lock = Some(t_e.index());
                        }
                    }
                }
            }
            if let Some(target_id) = current_target_lock {
                w.entity_mut(ent_player)
                    .insert(components::TargetLock(target_id));
            } else {
                w.entity_mut(ent_player).remove::<components::TargetLock>();
            }

            if shoot && move_processed && last_shot_time.elapsed().as_secs_f64() > 0.15 {
                let wp = w
                    .get::<WeaponParameters>(ent_player)
                    .cloned()
                    .unwrap_or_default();
                for i in 0..wp.projectile_count {
                    let mut offset_angle = 0.0;
                    if wp.projectile_count > 1 {
                        offset_angle =
                            (i as f64 - (wp.projectile_count as f64 - 1.0) / 2.0) * wp.spread;
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
                        Some(ent_player), // Player is the shooter
                    ));
                }
                last_shot_time = std::time::Instant::now();
            }

            // --- AGGRO AI ---
            {
                let mut enemy_query = w.query::<(
                    Entity,
                    &EntityType,
                    &mut Transform,
                    &mut components::SteeringAgent,
                    Option<&DeathAge>,
                    Option<&WeaponParameters>,
                )>();
                for (entity, et, mut t, mut agent, death_age, weapon_opt) in
                    enemy_query.iter_mut(&mut w)
                {
                    if death_age.is_none()
                        && (et.0 == "enemy" || et.0 == "alien_ship" || et.0 == "companion")
                    {
                        let dx = p_x - t.x;
                        let dy = p_alt - t.y;
                        let dz = p_y - t.z;
                        let dist_sq = dx * dx + dy * dy + dz * dz;
                        if dist_sq < 16_000_000.0 {
                            // 4000 units range
                            agent.behavior = "attack".to_string();
                            let dist_xz = (dx * dx + dz * dz).sqrt().max(1.0);
                            let aim_yaw = dz.atan2(dx);
                            let aim_pitch = dy.atan2(dist_xz); // elevation toward player Y
                            t.rotation = aim_yaw;
                            let base_prob = if agent.behavior == "kamikaze" { 0.25 } else { 0.010 };
                            let fire_prob = base_prob * weapon_opt.map_or(1.0, |wp| wp.fire_rate_multiplier);
                            if rand::random::<f64>() < fire_prob {
                                let (color, size, count, spread) = if let Some(wp) = weapon_opt {
                                    (
                                        wp.projectile_color.clone(),
                                        wp.projectile_size,
                                        wp.projectile_count,
                                        wp.spread,
                                    )
                                } else {
                                    ("#ff3333".to_string(), 6.0_f64, 1_u32, 0.1_f64)
                                };
                                for shot_i in 0..count {
                                    let spread_offset = if count > 1 {
                                        (shot_i as f64 - (count as f64 - 1.0) * 0.5) * spread
                                    } else {
                                        0.0
                                    };
                                    // Calculate direction vectors for AI projectile spawn offset
                                    let dir_x = (aim_yaw + spread_offset).cos() * aim_pitch.cos();
                                    let dir_y = aim_pitch.sin();
                                    let dir_z = (aim_yaw + spread_offset).sin() * aim_pitch.cos();
                                    let spawn_dist = 40.0; // Offset from AI ship center

                                    projectiles_to_spawn.push((
                                        t.x + dir_x * spawn_dist,
                                        t.y + dir_y * spawn_dist,
                                        t.z + dir_z * spawn_dist,
                                        t.rotation,
                                        0.0, // pitch - AI projectiles currently fly straight, so pitch is effectively 0 for initial velocity
                                        color.clone(),
                                        size,
                                        Some(ent_player.index()), // Target is player
                                        Some(entity),             // AI entity is the shooter
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
                let mut p_query = w.query::<(
                    Entity,
                    &mut Projectile,
                    &mut Transform,
                    Option<&components::TargetLock>,
                )>();
                for (entity, mut proj, _p_trans, _lock_opt) in p_query.iter_mut(&mut w) {
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
            let mut projectiles_info: Vec<(Entity, f64, f64, f64, Option<Entity>)> = Vec::new();
            {
                let mut p_query = w.query::<(Entity, &Transform, &Projectile)>();
                for (entity, t, p) in p_query.iter(&mut w) {
                    projectiles_info.push((entity, t.x, t.y, t.z, p.shooter_id));
                }
            }

            let mut target_info: Vec<(Entity, f64, f64, f64, String)> = Vec::new();
            {
                let mut target_query = w.query_filtered::<(Entity, &Transform, &EntityType, Option<&DeathAge>), Without<Projectile>>();
                for (entity, t, ent_type, da) in target_query.iter(&mut w) {
                    if da.is_none()
                        && (ent_type.0 == "star"
                            || ent_type.0 == "companion"
                            || ent_type.0 == "enemy"
                            || ent_type.0 == "asteroid")
                    {
                        target_info.push((entity, t.x, t.y, t.z, ent_type.0.clone()));
                    }
                }
            }

            let mut combat_kills = 0;
            let mut enemy_kills_this_frame = 0;
            let mut asteroid_kills_this_frame = 0;
            let mut explosions_to_spawn: Vec<(f64, f64, f64)> = Vec::new(); // Queue for new 3D explosion entities
            let mut to_kill: Vec<Entity> = Vec::new(); // Queue for entity destruction

            for (p_entity, px, py, pz, shooter_opt) in projectiles_info {
                for (t_entity, tx, ty, tz, t_type) in &target_info {
                    // Skip self-collision
                    if let Some(sid) = shooter_opt {
                        if sid == *t_entity {
                            continue;
                        }
                    }

                    let dx = px - tx;
                    let dy = py - ty;
                    let dz = pz - tz;
                    let dist_sq = dx * dx + dy * dy + dz * dz;

                    let collision_radius = if t_type == "asteroid" {
                        let scale = w
                            .get::<components::Scale>(*t_entity)
                            .map(|s| s.0)
                            .unwrap_or(1.0);
                        25.0 * scale + 15.0 // scaled asteroid radius + projectile buffer
                    } else {
                        40.0
                    };

                    if dist_sq < collision_radius * collision_radius {
                        to_kill.push(p_entity);
                        to_kill.push(*t_entity);

                        // If it's an asteroid, mark it as persistently destroyed
                        if t_type == "asteroid" {
                            let persistent_id =
                                w.get::<components::PersistentId>(*t_entity).map(|p| p.0);
                            if let Some(pid) = persistent_id {
                                let mut persistent =
                                    w.get_resource_mut::<PersistentWorldState>().unwrap();
                                persistent.destroyed_ids.insert(pid);
                            }
                        }

                        explosions_to_spawn.push((*tx, *ty, *tz)); // 3D explosion
                        combat_kills += 1;
                        success_kill_this_frame = true;
                        if t_type == "enemy" {
                            enemy_kills_this_frame += 1;
                        }
                        if t_type == "asteroid" {
                            asteroid_kills_this_frame += 1;
                        }
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
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_secs();
                    let payload = serde_json::json!({
                        "event_type": "combat_kill",
                        "count": combat_kills,
                        "cause": "player_shot",
                        "timestamp": format!("{}", ts)
                    });
                    let _ = client
                        .post("http://127.0.0.1:8000/engine_telemetry")
                        .json(&payload)
                        .send()
                        .await;
                });
            }

            // 2.5. AI-vs-AI Faction Collision Detection
            // MOVED/REPLACED: Collision between entities and asteroids/each other.
            // Faction proximity destruction (pirate vs federation) removed to prevent autonomous explosions.
            let mut non_player_enemy_deaths: usize = 0; // enemies killed by asteroids / BH (not player)
            {
                let mut hostiles: Vec<(Entity, f64, f64, f64, String, Option<u64>)> = Vec::new();
                let mut asteroids: Vec<(Entity, f64, f64, f64, f64, u64)> = Vec::new();

                {
                    let mut q = w.query_filtered::<(
                        Entity,
                        &Transform,
                        &EntityType,
                        Option<&Scale>,
                        Option<&PersistentId>,
                        Option<&DeathAge>,
                    ), Without<Projectile>>();
                    for (e, t, et, scale, pid, da) in q.iter(&w) {
                        if da.is_some() {
                            continue;
                        }
                        if et.0 == "enemy" || et.0 == "companion" {
                            hostiles.push((e, t.x, t.y, t.z, et.0.clone(), pid.map(|p| p.0)));
                        } else if et.0 == "asteroid" {
                            let s = scale.map(|s| s.0).unwrap_or(1.0);
                            let id = pid.map(|p| p.0).unwrap_or(0);
                            asteroids.push((e, t.x, t.y, t.z, s, id));
                        }
                    }
                }

                for (he, hx, hy, hz, htype, _hpid) in hostiles {
                    for (ae, ax, ay, az, ascale, apid) in &asteroids {
                        let dx = hx - ax;
                        let dy = hy - ay;
                        let dz = hz - az;
                        let dist_sq = dx * dx + dy * dy + dz * dz;
                        // REDUCED COLLISION SENSITIVITY: 18.0 (ship) + (12.0 * scale) (asteroid)
                        let coll_radius = 18.0 + (12.0 * ascale);

                        if dist_sq < coll_radius * coll_radius {
                            println!("[Engine] Collision: {} {} hit Asteroid {} at ({:.1}, {:.1}, {:.1})", htype, he.index(), apid, ax, ay, az);
                            if htype == "enemy" {
                                non_player_enemy_deaths += 1;
                            }
                            to_kill.push(he);
                            to_kill.push(*ae);
                            explosions_to_spawn.push((hx, hy, hz));
                            explosions_to_spawn.push((*ax, *ay, *az));

                            // Mark asteroid as persistently destroyed
                            let mut persistent =
                                w.get_resource_mut::<PersistentWorldState>().unwrap();
                            persistent.destroyed_ids.insert(*apid);
                            break;
                        }
                    }
                }
            }

            // 3. Schwarzschild Radius Physics
            // Event horizon: rs = anomaly.mass * SCHWARZSCHILD_K (game constant),
            // floored by anomaly.radius * 0.5 so visual size still acts as minimum.
            // Immune: player, planet only. Sun is now vulnerable to sufficiently massive anomalies.
            const SCHWARZSCHILD_K: f64 = 1.5;
            let mut anomaly_consumed: Vec<(String, String)> = Vec::new(); // (entity_type, name)
            {
                let mut anomaly_query = w.query::<(&SpatialAnomaly, &Transform)>();
                let mut agent_query = w.query_filtered::<(Entity, &Transform, Option<&DeathAge>), Without<SpatialAnomaly>>();

                for (anomaly, a_trans) in anomaly_query.iter(&w) {
                    if anomaly.anomaly_type == "black_hole" {
                        // Sun is excluded — it uses collision physics only, not Schwarzschild consumption.
                        // (Sun mass=50000 → event_horizon=75000 would consume player + all asteroids.)
                        let event_horizon = (anomaly.mass * SCHWARZSCHILD_K).max(anomaly.radius * 0.5);
                        for (entity, t, death_age) in agent_query.iter(&w) {
                            if death_age.is_none() {
                                let mut ent_type_str = String::new();
                                if let Some(ent_type) = w.get::<EntityType>(entity) {
                                    ent_type_str = ent_type.0.clone();
                                }
                                let is_immune = ent_type_str == "anomaly";

                                if !is_immune {
                                    let dx = a_trans.x - t.x;
                                    let dy = a_trans.y - t.y;
                                    let dz = a_trans.z - t.z;
                                    if (dx * dx + dy * dy + dz * dz).sqrt() < event_horizon {
                                        let ent_name = w
                                            .get::<Name>(entity)
                                            .map(|n| n.0.clone())
                                            .unwrap_or_default();
                                        anomaly_consumed.push((ent_type_str.clone(), ent_name));
                                        to_kill.push(entity);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Count only the anomaly kills (entries added in block above),
            // not the full to_kill vec which also contains projectile/collision kills.
            let anomaly_kill_count = anomaly_consumed.len();
            // Enemies consumed by black hole also count as non-player deaths → need replacement
            non_player_enemy_deaths += anomaly_consumed.iter().filter(|(et, _)| et == "enemy").count();

            for e in to_kill {
                if let Some(mut entity_mut) = w.get_entity_mut(e) {
                    entity_mut.insert(DeathAge(0.0));
                }
            }

            // Apply mass growth to the anomaly and trigger Game Over if Player was consumed.
            let mut player_consumed = false;
            let mut mass_gained = 0.0;
            for (et_str, _) in &anomaly_consumed {
                if et_str == "player" {
                    player_consumed = true;
                } else if et_str == "planet" || et_str == "sun" {
                    mass_gained += 25000.0;
                } else if et_str == "enemy" || et_str == "companion" {
                    mass_gained += 500.0;
                } else {
                    mass_gained += 150.0; // Asteroid, etc.
                }
            }

            // Immediately fail the game if player was sucked in
            if player_consumed {
                bh_death_active = true;
                let mut h = player_health_for_loop.lock().unwrap();
                *h = 0.0; // Force health to 0 to trigger game over logic below
            }

            // Actually increase the mass of the black holes so they grow!
            if mass_gained > 0.0 {
                let mut anomaly_query = w.query::<&mut SpatialAnomaly>();
                for mut anomaly in anomaly_query.iter_mut(&mut w) {
                    if anomaly.anomaly_type == "black_hole" {
                        anomaly.mass += mass_gained;
                        // For visual scaling, pass radius down slowly
                        anomaly.radius += mass_gained * 0.005; 
                    }
                }
            }

            if anomaly_kill_count > 0 {
                let consumed_clone = anomaly_consumed.clone();
                tokio::spawn(async move {
                    let client = reqwest::Client::new();
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_secs();
                    let payload = serde_json::json!({
                        "event_type": "anomaly_kill",
                        "count": anomaly_kill_count,
                        "cause": "black_hole",
                        "timestamp": format!("{}", ts)
                    });
                    let _ = client
                        .post("http://127.0.0.1:8000/engine_telemetry")
                        .json(&payload)
                        .send()
                        .await;

                    // Fire anomaly_consumption if a sun or star was consumed
                    let sun_star_consumed: Vec<&(String, String)> = consumed_clone
                        .iter()
                        .filter(|(et, _)| et == "sun" || et == "star")
                        .collect();
                    if !sun_star_consumed.is_empty() {
                        let cause_name = sun_star_consumed[0].1.clone();
                        let cause_type = sun_star_consumed[0].0.clone();
                        let consumption_payload = serde_json::json!({
                            "event_type": "anomaly_consumption",
                            "count": sun_star_consumed.len(),
                            "cause": format!("{} ({})", cause_type, cause_name),
                            "timestamp": format!("{}", ts)
                        });
                        let _ = client
                            .post("http://127.0.0.1:8000/engine_telemetry")
                            .json(&consumption_payload)
                            .send()
                            .await;
                    }
                });
            }

            // ---- Player Damage System ----
            {
                let cd = *damage_cooldown_for_loop.lock().unwrap();
                let got = *game_over_timer_for_loop.lock().unwrap();

                if got <= 0.0 && cd <= 0.0 {
                    // Step 1: collect player position
                    let mut player_pos_opt = None;
                    {
                        let mut pq = w.query::<(&EntityType, &Transform)>();
                        for (et, t) in pq.iter(&w) {
                            if et.0 == "player" {
                                player_pos_opt = Some((t.x, t.y, t.z));
                                break;
                            }
                        }
                    }

                    if let Some((px, py, pz)) = player_pos_opt {
                        // Step 2: collect hostile entities in collision range
                        let mut hostile_hits: Vec<(Entity, String, f64, f64, Option<u64>)> =
                            Vec::new();
                        let mut hit_dir = (0.0_f64, 0.0_f64, 0.0_f64);
                        {
                            let mut hq = w.query::<(
                                Entity,
                                &Transform,
                                &EntityType,
                                Option<&DeathAge>,
                                Option<&Faction>,
                                Option<&Scale>,
                                Option<&PersistentId>,
                            )>();
                            for (e, t, et, da, faction_opt, scale_opt, persistent_id_opt) in
                                hq.iter(&w)
                            {
                                if da.is_some() {
                                    continue;
                                }
                                if et.0 == "enemy" || et.0 == "asteroid" {
                                    if let Some(f) = faction_opt {
                                        if f.0 == "federation" {
                                            continue;
                                        }
                                    }
                                    let scale_val = scale_opt.map(|s| s.0).unwrap_or(1.0);
                                    let collision_radius = if et.0 == "asteroid" {
                                        28.0 * scale_val + 25.0 // asteroid radius + player radius
                                    } else {
                                        55.0 // static enemy radius
                                    };

                                    let dx = px - t.x;
                                    let dy = py - t.y;
                                    let dz = pz - t.z;
                                    let dist_sq = dx * dx + dy * dy + dz * dz;

                                    if dist_sq < collision_radius * collision_radius {
                                        let dist = dist_sq.sqrt().max(1.0);
                                        if hit_dir == (0.0, 0.0, 0.0) {
                                            hit_dir = (dx / dist, dy / dist, dz / dist);
                                        }
                                        let mass = if et.0 == "asteroid" {
                                            scale_val * 50.0
                                        } else {
                                            100.0
                                        };
                                        hostile_hits.push((
                                            e,
                                            et.0.clone(),
                                            mass,
                                            dist,
                                            persistent_id_opt.map(|p| p.0),
                                        ));
                                    }
                                }
                            }
                        }

                        if !hostile_hits.is_empty() {
                            let mut hits_this_frame = 0;
                            let mut enemies_hit = 0;
                            let mut asteroids_hit = 0;

                            // Apply damage based on mass and player velocity
                            let (vx_p, vy_p, vz_p) = {
                                let mut pq = w.query::<(&EntityType, &PhysicsType)>();
                                let mut v = (0.0, 0.0, 0.0);
                                for (et, pt) in pq.iter(&w) {
                                    if et.0 == "player" {
                                        if let PhysicsType::Velocity { vx, vy, vz } = pt {
                                            v = (*vx, *vy, *vz);
                                        }
                                        break;
                                    }
                                }
                                v
                            };
                            let player_speed = (vx_p * vx_p + vy_p * vy_p + vz_p * vz_p).sqrt();

                            let mut total_damage = 0.0;
                            for (_, _et_type, mass, _, pid) in &hostile_hits {
                                // Damage = (mass * velocity) / factor
                                let damage = (mass * player_speed.max(100.0) * 0.0004).max(5.0);
                                total_damage += damage;

                                // Track persistent destruction
                                if let Some(id) = pid {
                                    let mut persistent =
                                        w.get_resource_mut::<PersistentWorldState>().unwrap();
                                    persistent.destroyed_ids.insert(*id);
                                }
                            }

                            let new_health = {
                                let mut h = player_health_for_loop.lock().unwrap();
                                *h = (*h - total_damage).max(0.0);
                                *h
                            };
                            *damage_cooldown_for_loop.lock().unwrap() = 1.0;
                            *player_knockback_for_loop.lock().unwrap() =
                                (hit_dir.0 * 520.0, hit_dir.1 * 520.0);

                            for (e, et_type, _, _, _) in &hostile_hits {
                                if let Some(mut em) = w.get_entity_mut(*e) {
                                    em.insert(DeathAge(0.0));
                                    hits_this_frame += 1;
                                    if et_type == "enemy" {
                                        enemies_hit += 1;
                                    }
                                    if et_type == "asteroid" {
                                        asteroids_hit += 1;
                                    }
                                }
                            }

                            // Credit kills to the player for colliding!
                            if hits_this_frame > 0 {
                                *total_kills_for_loop.lock().unwrap() += hits_this_frame as u32;
                                *total_enemy_kills_for_loop.lock().unwrap() += enemies_hit as u32;
                                *total_asteroid_kills_for_loop.lock().unwrap() +=
                                    asteroids_hit as u32;
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
                                            velocity: (
                                                angle.cos() * speed,
                                                angle.sin() * speed,
                                                rng.gen_range(-80.0..80.0),
                                            ),
                                            lifespan: 1.8,
                                            max_lifespan: 1.8,
                                            color: "rgba(255, 210, 60, 0.95)".to_string(),
                                        },
                                        Transform {
                                            x: px,
                                            y: py,
                                            z: 0.0,
                                            rotation: 0.0,
                                        },
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
                                    let _ = client
                                        .post("http://127.0.0.1:8000/engine_telemetry")
                                        .json(&payload)
                                        .send()
                                        .await;
                                });
                            }
                        }
                    }
                }

                // Tick invincibility cooldown
                {
                    let mut cd = damage_cooldown_for_loop.lock().unwrap();
                    if *cd > 0.0 {
                        *cd = (*cd - 0.016).max(0.0);
                    }
                }

                // Tick game-over timer; reset player after 3 s
                {
                    let mut got = game_over_timer_for_loop.lock().unwrap();
                    if *got > 0.0 {
                        *got = (*got - 0.016).max(0.0);
                        if *got <= 0.0 {
                            // Resurrect: restore health and teleport back to origin
                            bh_death_active = false;
                            *player_health_for_loop.lock().unwrap() = 100.0;
                            let mut pq =
                                w.query::<(&EntityType, &mut Transform, Option<&mut DeathAge>)>();
                            for (et, mut t, da_opt) in pq.iter_mut(&mut w) {
                                if et.0 == "player" {
                                    t.x = 8500.0; // Start near Earth again
                                    t.y = 500.0;
                                    t.z = 0.0;
                                    // Remove DeathAge if still present
                                    if let Some(mut da) = da_opt {
                                        da.0 = -1.0; // Effectively disable it
                                    }
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
                // CRITICAL: Player must NEVER be despawned from ECS.
                if death_age.0 >= 1.0 && ent_type.0 != "player" {
                    entities_to_despawn.push(entity);
                }
            }

            // 4. (Deprecated) Particle Shatters removed in favor of 3D Explosions
            // Kept dead particle cleanup just in case.
            for e in entities_to_despawn {
                w.despawn(e);
            }

            // Spawn replacement enemies ONLY when no black hole is active.
            // If a BH is consuming the world, spawning replacements creates an infinite treadmill
            // where the BH can never empty the world because enemies keep respawning.
            let bh_active = {
                let mut bh_q = w.query::<&SpatialAnomaly>();
                bh_q.iter(&w).any(|a| a.anomaly_type == "black_hole")
            };
            if non_player_enemy_deaths > 0 && !is_game_over_this_frame && !bh_active && !is_transitioning_active {
                let variant = if current_level >= 10 { 2 } else if current_level >= 5 { 1 } else { 0 };
                let range = if current_level <= 2 {
                    (1500.0, 4000.0)
                } else {
                    (3000.0 + current_level as f64 * 500.0, 6000.0 + current_level as f64 * 1000.0)
                };
                spawn_wave(&mut w, non_player_enemy_deaths, "pirate", "enemy", range, variant);
                println!("[Engine] Spawned {} replacement enemies (non-player deaths, level {})", non_player_enemy_deaths, current_level);
            }

            // Spawn 3D Explosions
            for (ex, ey, ez) in explosions_to_spawn {
                w.spawn((
                    EntityType("explosion".to_string()),
                    Transform {
                        x: ex,
                        y: ey,
                        z: ez,
                        rotation: 0.0,
                    }, // Fixed: Use ez
                    SpawnAge(0.0),
                    Visuals {
                        model_type: Some("sphere".to_string()),
                        color: "#f59e0b".to_string(),
                        is_cloaked: false,
                    },
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
            let live_count = {
                let mut q = w.query::<&Projectile>();
                q.iter(&w).count()
            };
            if live_count >= 300 {
                projectiles_to_spawn.clear();
            }
            for (px, py, pz, prot, ppitch, pcolor, psize, target_lock, shooter_id) in
                projectiles_to_spawn
            {
                let mut ent = w.spawn((
                    EntityType("projectile".to_string()),
                    Transform {
                        x: px,
                        y: py,
                        z: pz,
                        rotation: prot,
                    },
                    Projectile {
                        velocity: (0.0, 0.0, 0.0), // unused — PhysicsType::Projectile drives movement
                        lifespan: 5.0,             // Doubled from 2.5
                        color: pcolor,
                        size: psize,
                        shooter_id,
                    },
                    PhysicsType::Projectile {
                        speed: 50.0,
                        pitch_angle: ppitch,
                    },
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
        let elapsed_time = level_start_time_for_loop
            .lock()
            .unwrap()
            .elapsed()
            .as_secs();

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
                    if dist > crate::world::MAX_WORLD_RADIUS {
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
                    if et.0 == "player" {
                        p_pos = (t.x, t.z);
                    }
                    if let Some(n) = name {
                        if n.0 == "Mars" {
                            mars_pos = (t.x, t.z);
                        }
                        if n.0 == "Jupiter" {
                            jup_pos = (t.x, t.z);
                        }
                    }
                }
            }

            let dist_to_mars =
                ((p_pos.0 - mars_pos.0).powi(2) + (p_pos.1 - mars_pos.1).powi(2)).sqrt();
            let dist_to_jupiter =
                ((p_pos.0 - jup_pos.0).powi(2) + (p_pos.1 - jup_pos.1).powi(2)).sqrt();

            let target_kills = current_score.saturating_sub(kills_at_level_start);
            let enemy_kills = current_enemy_kills.saturating_sub(enemy_kills_at_level_start);
            let asteroid_kills =
                current_asteroid_kills.saturating_sub(asteroid_kills_at_level_start);

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
                if target_kills >= 15 {
                    current_level = 2;
                    level_advanced = true;
                }
            } else if current_level == 2 {
                objective = format!("LEVEL 2: Destroy 5 Enemy Ships ({}/5)", enemy_kills);
                if enemy_kills >= 5 {
                    current_level = 3;
                    level_advanced = true;
                }
            } else if current_level == 3 {
                objective = format!("LEVEL 3: Survive for 60 seconds ({}s/60s)", elapsed_time);
                if elapsed_time >= 60 {
                    current_level = 4;
                    level_advanced = true;
                }
            } else if current_level == 4 {
                // LEVEL 4 ESCORT MISSION
                let mut transport_exists = false;
                let mut transport_health = 0.0;
                let mut transport_max_health = 100.0;

                {
                    let mut tq = w.query::<(&EntityType, &Name, &Health)>();
                    for (et, name, health) in tq.iter(&w) {
                        if et.0 == "neutral" && name.0 == "Civilian Transport" {
                            transport_exists = true;
                            transport_health = health.current;
                            transport_max_health = health.max;
                            break;
                        }
                    }
                }

                if !transport_exists && !is_transitioning_active {
                    // Spawn the transport near the player
                    println!("[Level 4] Spawning Civilian Transport...");
                    w.spawn((
                        EntityType("neutral".to_string()),
                        Name("Civilian Transport".to_string()),
                        Transform {
                            x: p_pos.0 + 500.0,
                            y: 0.0,
                            z: p_pos.1 + 500.0,
                            rotation: 0.0,
                        },
                        PhysicsType::Velocity { vx: 20.0, vy: 0.0, vz: 20.0 },
                        SteeringAgent {
                            velocity: (20.0, 0.0, 20.0),
                            max_speed: 40.0,
                            max_force: 1.0,
                            behavior: "neutral_wander".to_string(),
                        },
                        Health { current: 200.0, max: 200.0 },
                        Faction("neutral".to_string()),
                        Visuals {
                            model_type: Some("space_shuttle_b".to_string()),
                            color: "#38bdf8".to_string(),
                            is_cloaked: false,
                        },
                        SpatialAnomaly {
                            anomaly_type: "ship".to_string(),
                            mass: 0.0,
                            radius: 60.0,
                        },
                    ));
                }

                objective = format!(
                    "LEVEL 4: Protect Civilian Transport ({:.0}%) [{}s/60s]",
                    (transport_health / transport_max_health * 100.0),
                    elapsed_time
                );

                if transport_exists && transport_health <= 0.0 {
                    println!("[Level 4] Transport DESTROYED! Resetting mission...");
                    // Reset Level 4
                    *level_start_time_for_loop.lock().unwrap() = std::time::Instant::now();
                    // Cleanup existing enemies to give player a fresh start
                    let mut to_cleanup = Vec::new();
                    let mut eq = w.query::<(Entity, &EntityType)>();
                    for (e, et) in eq.iter(&w) {
                        if et.0 == "enemy" { to_cleanup.push(e); }
                    }
                    for e in to_cleanup { w.despawn(e); }
                }

                if elapsed_time >= 60 && transport_exists && transport_health > 0.0 {
                    current_level = 5;
                    level_advanced = true;
                }
            } else if current_level == 5 {
                let m_fmt = if dist_to_mars < 3000.0 {
                    "Mars Reached".to_string()
                } else {
                    format!("Dist: {:.0}", dist_to_mars)
                };
                objective = format!(
                    "LEVEL 5: Reach Mars & Destroy 10 Enemies [{}, {}/10]",
                    m_fmt, enemy_kills
                );
                if dist_to_mars < 3000.0 && enemy_kills >= 10 {
                    current_level = 6;
                    level_advanced = true;
                }
            } else if current_level == 6 {
                objective = format!("LEVEL 6: Destroy 40 Asteroids ({}/40)", asteroid_kills);
                if asteroid_kills >= 40 {
                    current_level = 7;
                    level_advanced = true;
                }
            } else if current_level == 7 {
                objective = format!("LEVEL 7: Survive for 90 seconds ({}s/90s)", elapsed_time);
                if elapsed_time >= 90 {
                    current_level = 8;
                    level_advanced = true;
                }
            } else if current_level == 8 {
                let j_fmt = if dist_to_jupiter < 4000.0 {
                    "Jupiter Reached".to_string()
                } else {
                    format!("Dist: {:.0}", dist_to_jupiter)
                };
                objective = format!(
                    "LEVEL 8: Reach Jupiter & Destroy 20 Enemies [{}, {}/20]",
                    j_fmt, enemy_kills
                );
                if dist_to_jupiter < 4000.0 && enemy_kills >= 20 {
                    current_level = 9;
                    level_advanced = true;
                }
            } else if current_level == 9 {
                objective = format!("LEVEL 9: Destroy 50 mixed targets ({}/50)", target_kills);
                if target_kills >= 50 {
                    current_level = 10;
                    level_advanced = true;
                }
            } else if current_level == 10 {
                objective = format!(
                    "FINAL WAVE: Survive 3m ({}s/180s) or kill 100 targets ({}/100)",
                    elapsed_time, target_kills
                );
                if elapsed_time >= 180 || target_kills >= 100 {
                    objective = "VICTORY: The Void is quiet.".to_string();
                    current_level = 11;
                    level_advanced = true;
                }
            } else {
                objective = "VICTORY: The Void is quiet.".to_string();
            }

            if out_of_bounds {
                objective =
                    "Pilot, you are leaving the mission sector. Return immediately.".to_string();
            }

            if level_advanced {
                println!(">>> ADVANCED TO LEVEL {}! <<<", current_level);
                *game_over_timer_for_loop.lock().unwrap() = 0.0;
                *level_transition_timer_for_loop.lock().unwrap() = 2.5;

                // Fire telemetry for AI Director
                tokio::spawn(async move {
                    let client = reqwest::Client::new();
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_secs();
                    let payload = serde_json::json!({
                        "event_type": "level_up",
                        "count": current_level,
                        "cause": format!("Level {} Objective Completed", current_level - 1),
                        "timestamp": format!("{}", ts)
                    });
                    let _ = client
                        .post("http://127.0.0.1:8000/engine_telemetry")
                        .json(&payload)
                        .send()
                        .await;
                });

                // --- PHASE 8.3: WORLD CLEAR PASS ---
                // Despawn old enemies and projectiles on level advance. Asteroids persist as permanent world geometry.
                let mut to_cleanup: Vec<Entity> = Vec::new();
                {
                    let mut q = w.query::<(Entity, &EntityType)>();
                    for (e, et) in q.iter(&w) {
                        if et.0 == "enemy" || et.0 == "projectile" {
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
                    (
                        3000.0 + (current_level as f64 * 500.0),
                        6000.0 + (current_level as f64 * 1000.0),
                    )
                };

                // Tier logic: Higher levels spawn scarier ships
                let variant = if current_level >= 10 {
                    2
                } else if current_level >= 5 {
                    1
                } else {
                    0
                };
                spawn_wave(&mut w, enemy_count, "pirate", "enemy", range, variant);

                kills_at_level_start = current_score;
                enemy_kills_at_level_start = current_enemy_kills;
                asteroid_kills_at_level_start = current_asteroid_kills;
                *level_start_time_for_loop.lock().unwrap() = std::time::Instant::now();
            }
        }

        // Pre-fetch player position so we can early-exit distant asteroids in the
        // main query, avoiding building and discarding EntityData for all 22k rocks.
        let mut player_pos = (0.0_f64, 0.0_f64);
        {
            let mut w = world.lock().unwrap();
            let mut pq = w.query::<(&EntityType, &Transform)>();
            for (et, t) in pq.iter(&w) {
                if et.0 == "player" {
                    player_pos = (t.x, t.z);
                    break;
                }
            }
        }

        const ASTEROID_VIEW_SQ: f64 = 3000.0 * 3000.0;
        let mut entities_data: Vec<EntityData> = Vec::new();
        let mut particles_data: Vec<ParticleData> = Vec::new();

        // Collect entity data; skip distant asteroids before allocating EntityData
        {
            let (px, pz) = player_pos;
            let mut w = world.lock().unwrap();
            let mut rng = rand::thread_rng();
            use rand::Rng;

            // Neutral ships are spawned once at init (5 unique models) — no dynamic respawning
            let mut query = w.query::<(
                Entity,
                &Transform,
                &EntityType,
                (Option<&PhysicsType>, Option<&BirthAge>, Option<&DeathAge>),
                (
                    Option<&SteeringAgent>,
                    Option<&SpatialAnomaly>,
                    Option<&Projectile>,
                ),
                (Option<&Faction>, Option<&Visuals>, Option<&Parent>),
                (
                    Option<&SpawnAge>,
                    Option<&PersistentId>,
                    Option<&ModelVariant>,
                    Option<&Scale>,
                    Option<&Name>,
                    Option<&TargetLock>,
                    Option<&Health>,
                ),
            )>();
            for (
                entity,
                transform,
                ent_type,
                (phys_type, birth_age, death_age),
                (steering, anomaly, _projectile),
                (faction_opt, visuals, parent_opt),
                (
                    spawn_age_opt,
                    persistent_id_opt,
                    variant_opt,
                    scale_opt,
                    name_opt,
                    target_lock_opt,
                    health_opt,
                ),
            ) in query.iter(&w)
            {
                // Early-exit for distant asteroids — avoids ~22k EntityData allocs per frame
                if ent_type.0 == "asteroid" {
                    let dx = transform.x - px;
                    let dz = transform.z - pz;
                    if dx * dx + dz * dz > ASTEROID_VIEW_SQ {
                        continue;
                    }
                }

                let speed: f64 = match phys_type {
                    Some(PhysicsType::Orbital { speed, .. }) => *speed,
                    Some(PhysicsType::Sinusoidal { frequency, .. }) => frequency * 0.3,
                    Some(PhysicsType::Projectile { speed, .. }) => *speed,
                    Some(PhysicsType::Velocity { vx, vy, vz }) => {
                        (vx * vx + vy * vy + vz * vz).sqrt()
                    }
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
                    "player" => "player",
                    "companion" => "companion",
                    "star" => "star",
                    "anomaly" => "anomaly",
                    "projectile" => "projectile",
                    _ => "other",
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
                        "sun" => Some(1000.0),
                        "planet" => Some(anomaly.map_or(20.0, |a| a.radius)),
                        "moon" => Some(anomaly.map_or(30.0, |a| a.radius)),
                        "enemy" => Some(if model_variant == Some(2) {
                            100.0
                        } else if model_variant == Some(1) {
                            40.0
                        } else {
                            18.0
                        }),
                        "companion" => Some(18.0),
                        _ => None,
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
            (
                wstate.environment_theme.clone(),
                wstate.terrain_rules.clone(),
            )
        };

        // Keep current_level_shared in sync so save route can read it
        *current_level_shared_for_loop.lock().unwrap() = current_level;

        let current_health = *player_health_for_loop.lock().unwrap();
        let current_score = *total_kills_for_loop.lock().unwrap();
        let current_game_over = *game_over_timer_for_loop.lock().unwrap() > 0.0;

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
            is_transitioning: is_transitioning_active,
            black_hole_death: bh_death_active && current_game_over,
            objective: objective,
            kills_in_level: current_score, // Simplified tracker
            success_kill: success_kill_this_frame,
            radar_filters: {
                let s = state.lock().unwrap();
                s.radar_filters.clone()
            },
            audio_settings: {
                let s = state.lock().unwrap();
                s.audio_settings.clone()
            },
        };

        match serde_json::to_string(&update) {
            Ok(json) => {
                let msg = warp::ws::Message::text(json);
                let mut clients_guard = clients.lock().unwrap();
                let client_count = clients_guard.len();

                // --- DIAGNOSTIC PRINT (Prints every 'print_counter' frames) ---
                if print_counter % 60 == 0 {
                    println!(
                        "[DIAGNOSTIC] Frame {} - Broadcasting to {} clients",
                        print_counter, client_count
                    );
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
                println!(
                    "CRITICAL ERROR: Failed to serialize RenderFrameState: {}",
                    e
                );
            }
        }

        tokio::time::sleep(std::time::Duration::from_millis(16)).await; // ~60fps
    }
}

pub async fn client_connection(
    ws: warp::ws::WebSocket,
    clients: Clients,
    input_state: Arc<Mutex<PlayerInputState>>,
) {
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
                                state.up = cmd.keys.contains(&"KeyW".to_string())
                                    || cmd.keys.contains(&"ArrowUp".to_string());
                                state.down = cmd.keys.contains(&"KeyS".to_string())
                                    || cmd.keys.contains(&"ArrowDown".to_string());
                                state.left = cmd.keys.contains(&"KeyA".to_string())
                                    || cmd.keys.contains(&"ArrowLeft".to_string());
                                state.right = cmd.keys.contains(&"KeyD".to_string())
                                    || cmd.keys.contains(&"ArrowRight".to_string());
                                state.shoot = cmd.keys.contains(&"Space".to_string());
                                state.boost = cmd.keys.contains(&"ShiftLeft".to_string())
                                    || cmd.keys.contains(&"ShiftRight".to_string());
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

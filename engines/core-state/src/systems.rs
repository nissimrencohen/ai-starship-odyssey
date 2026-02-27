use bevy_ecs::prelude::*;
use crate::components::*;

#[derive(Resource)]
pub struct RealityModifiersRes {
    pub gravity: f32,
    pub friction: f32,
}

pub fn environmental_physics_system(
    res: Option<Res<RealityModifiersRes>>,
    anomaly_query: Query<(&SpatialAnomaly, &Transform)>,
    mut agent_query: Query<(&mut SteeringAgent, &Transform)>,
) {
    let mut g_constant: f32 = 50.0;
    if let Some(r) = res {
        g_constant *= r.gravity;
    }
    
    for (anomaly, a_transform) in anomaly_query.iter() {
        for (mut agent, transform) in agent_query.iter_mut() {
            let dx = a_transform.x - transform.x;
            let dy = a_transform.y - transform.y;
            let dz = a_transform.z - transform.z;
            let dist_sq = dx * dx + dy * dy + dz * dz;
            let dist = dist_sq.sqrt().max(1.0);
            
            // F = G * (m1*m2)/d^2.  m2 = 1.0 for agents.
            let force_mag = g_constant * anomaly.mass / dist_sq.max(100.0);
            let dir_x = dx / dist;
            let dir_y = dy / dist;
            let dir_z = dz / dist;
            
            // Apply Newtonian Force to velocity
            if anomaly.anomaly_type == "repulsor" {
                agent.velocity.0 -= dir_x * force_mag * 0.016;
                agent.velocity.1 -= dir_y * force_mag * 0.016;
                agent.velocity.2 -= dir_z * force_mag * 0.016;
            } else if anomaly.anomaly_type == "black_hole" {
                agent.velocity.0 += dir_x * force_mag * 0.016;
                agent.velocity.1 += dir_y * force_mag * 0.016;
                agent.velocity.2 += dir_z * force_mag * 0.016;
                
                // Event Horizon Overpowering!
                if dist < anomaly.radius * 1.5 {
                    // Completely overpower behaviors by forcing "idle" state
                    agent.behavior = "idle".to_string();
                }
            }
        }
    }
}

pub fn particle_physics_system(
    mut query: Query<(&mut Particle, &mut Transform)>,
    anomaly_query: Query<(&SpatialAnomaly, &Transform), Without<Particle>>,
) {
    let g_constant: f32 = 50.0;
    
    for (mut particle, mut transform) in query.iter_mut() {
        // Decrease lifespan
        particle.lifespan -= 0.016;
        
        let mut ax = 0.0;
        let mut ay = 0.0;
        let mut az = 0.0;

        // Apply Newtonian gravity from anomalies (but not repulsors for dramatic effect)
        for (anomaly, a_transform) in anomaly_query.iter() {
            if anomaly.anomaly_type == "black_hole" {
                let dx = a_transform.x - transform.x;
                let dy = a_transform.y - transform.y;
                let dz = a_transform.z - transform.z;
                let dist_sq = dx * dx + dy * dy + dz * dz;
                let dist = dist_sq.sqrt().max(1.0);
                
                let force_mag = g_constant * anomaly.mass / dist_sq.max(100.0);
                ax += (dx / dist) * force_mag * 0.016;
                ay += (dy / dist) * force_mag * 0.016;
                az += (dz / dist) * force_mag * 0.016;
            }
        }

        particle.velocity.0 += ax;
        particle.velocity.1 += ay;
        particle.velocity.2 += az;

        transform.x += particle.velocity.0 * 0.016 * 60.0;
        transform.y += particle.velocity.1 * 0.016 * 60.0;
        transform.z += particle.velocity.2 * 0.016 * 60.0;
    }
}

pub fn steering_system(
    res: Option<Res<RealityModifiersRes>>,
    mut query: Query<(&mut SteeringAgent, &Transform, Option<&crate::components::Faction>)>,
    player_query: Query<(&Transform, &EntityType)>
) {
    let friction = res.map_or(0.95, |r| r.friction);

    // 1. Find the player
    let mut px = 0.0;
    let mut py = 0.0;
    let mut pz = 0.0;
    for (t, e) in player_query.iter() {
        if e.0 == "player" {
            px = t.x;
            py = t.y;
            pz = t.z;
            break;
        }
    }

    // 2. Gather all agent positions, factions for target finding and swarm separation
    let mut agent_positions: Vec<(f32, f32, f32, String)> = Vec::new();
    for (_, t, faction_opt) in query.iter() {
        let faction = faction_opt.map_or("neutral".to_string(), |f| f.0.clone());
        agent_positions.push((t.x, t.y, t.z, faction));
    }

    // 3. Apply steering behaviors
    let mut idx = 0;
    for (mut agent, transform, faction_opt) in query.iter_mut() {
        let my_faction = faction_opt.map_or("neutral", |f| f.0.as_str());

        if agent.behavior == "idle" {
            // Decelerate smoothly using dynamically requested friction modifier
            agent.velocity.0 *= friction;
            agent.velocity.1 *= friction;
            agent.velocity.2 *= friction;
            idx += 1;
            continue;
        }

        let mut desired_vx = 0.0;
        let mut desired_vy = 0.0;
        let mut desired_vz = 0.0;

        // Find the best target: nearest hostile entity, or fallback to player
        let (target_x, target_y, target_z) = {
            let mut best_target = None;
            let mut best_dist_sq = f32::MAX;

            for (i, (ax, ay, az, ref af)) in agent_positions.iter().enumerate() {
                if i == idx { continue; } // don't target self
                // Check hostility
                let hostile = match my_faction {
                    "pirate" => af == "federation",
                    "federation" => af == "pirate",
                    _ => false,
                };
                if !hostile { continue; }
                let dx = ax - transform.x;
                let dy = ay - transform.y;
                let dz = az - transform.z;
                let dist_sq = dx * dx + dy * dy + dz * dz;
                if dist_sq < best_dist_sq {
                    best_dist_sq = dist_sq;
                    best_target = Some((*ax, *ay, *az));
                }
            }

            if let Some(target) = best_target {
                target
            } else {
                // Fallback: pirate targets player, federation/neutral patrol idly
                if my_faction == "pirate" {
                    (px, py, pz)
                } else {
                    // No valid target — decelerate gently
                    agent.velocity.0 *= friction;
                    agent.velocity.1 *= friction;
                    agent.velocity.2 *= friction;
                    idx += 1;
                    continue;
                }
            }
        };

        let dx = target_x - transform.x;
        let dy = target_y - transform.y;
        let dz = target_z - transform.z;
        let dist = (dx * dx + dy * dy + dz * dz).sqrt().max(0.1);

        match agent.behavior.as_str() {
            "attack" => {
                // Seek nearest hostile target
                desired_vx = (dx / dist) * agent.max_speed;
                desired_vy = (dy / dist) * agent.max_speed;
                desired_vz = (dz / dist) * agent.max_speed;
            }
            "scatter" => {
                // Flee from target
                desired_vx = -(dx / dist) * agent.max_speed;
                desired_vy = -(dy / dist) * agent.max_speed;
                desired_vz = -(dz / dist) * agent.max_speed;
            }
            "protect" => {
                // Spherical Protection: 3D orbit around the player
                let cur_dx = transform.x - px;
                let cur_dy = transform.y - py;
                let cur_dz = transform.z - pz;
                
                let cur_dist = (cur_dx * cur_dx + cur_dy * cur_dy + cur_dz * cur_dz).sqrt().max(0.1);
                
                let target_x = px + (cur_dx / cur_dist) * 100.0;
                let target_y = py + (cur_dy / cur_dist) * 100.0;
                let target_z = pz + (cur_dz / cur_dist) * 100.0;
                
                let tdx = target_x - transform.x;
                let tdy = target_y - transform.y;
                let tdz = target_z - transform.z;
                let tdist = (tdx * tdx + tdy * tdy + tdz * tdz).sqrt().max(0.1);
                
                let speed = if tdist < 50.0 { agent.max_speed * (tdist / 50.0) } else { agent.max_speed };
                desired_vx = (tdx / tdist) * speed;
                desired_vy = (tdy / tdist) * speed;
                desired_vz = (tdz / tdist) * speed;
            }
            "swarm" => {
                // Seek nearest hostile target + Separate from others
                desired_vx = (dx / dist) * agent.max_speed;
                desired_vy = (dy / dist) * agent.max_speed;
                desired_vz = (dz / dist) * agent.max_speed;

                let mut sep_x = 0.0;
                let mut sep_y = 0.0;
                let mut sep_z = 0.0;
                let mut count = 0;
                let desired_separation = 40.0;

                for &(ax, ay, az, _) in &agent_positions {
                    let sdx = transform.x - ax;
                    let sdy = transform.y - ay;
                    let sdz = transform.z - az;
                    let sdist = (sdx * sdx + sdy * sdy + sdz * sdz).sqrt();
                    if sdist > 0.0 && sdist < desired_separation {
                        sep_x += (sdx / sdist) / sdist; // Weight by distance
                        sep_y += (sdy / sdist) / sdist;
                        sep_z += (sdz / sdist) / sdist;
                        count += 1;
                    }
                }

                if count > 0 {
                    sep_x /= count as f32;
                    sep_y /= count as f32;
                    sep_z /= count as f32;
                    // Normalize and scale separation
                    let sep_mag = (sep_x * sep_x + sep_y * sep_y + sep_z * sep_z).sqrt().max(0.1);
                    sep_x = (sep_x / sep_mag) * agent.max_speed * 1.5; // Stronger separation
                    sep_y = (sep_y / sep_mag) * agent.max_speed * 1.5;
                    sep_z = (sep_z / sep_mag) * agent.max_speed * 1.5;
                    
                    desired_vx += sep_x;
                    desired_vy += sep_y;
                    desired_vz += sep_z;
                }
            }
            _ => {}
        }
        
        // Z-Bounds: Apply a soft boundary on the Z-axis (Z=0, ceiling Z=1000)
        let z_future = transform.z + desired_vz * 0.016 * 60.0;
        if z_future < 0.0 {
            // Apply upward force
            desired_vz += (0.0 - transform.z) * 0.1;
        } else if z_future > 1000.0 {
            // Apply downward force
            desired_vz -= (transform.z - 1000.0) * 0.1;
        }

        // Apply Steering Force
        let steer_x = desired_vx - agent.velocity.0;
        let steer_y = desired_vy - agent.velocity.1;
        let steer_z = desired_vz - agent.velocity.2;
        
        let steer_mag = (steer_x * steer_x + steer_y * steer_y + steer_z * steer_z).sqrt();
        let mut final_steer_x = steer_x;
        let mut final_steer_y = steer_y;
        let mut final_steer_z = steer_z;
        
        if steer_mag > agent.max_force {
            final_steer_x = (steer_x / steer_mag) * agent.max_force;
            final_steer_y = (steer_y / steer_mag) * agent.max_force;
            final_steer_z = (steer_z / steer_mag) * agent.max_force;
        }

        agent.velocity.0 += final_steer_x;
        agent.velocity.1 += final_steer_y;
        agent.velocity.2 += final_steer_z;

        // Limit speed
        let speed = (agent.velocity.0 * agent.velocity.0 + agent.velocity.1 * agent.velocity.1 + agent.velocity.2 * agent.velocity.2).sqrt();
        if speed > agent.max_speed {
            agent.velocity.0 = (agent.velocity.0 / speed) * agent.max_speed;
            agent.velocity.1 = (agent.velocity.1 / speed) * agent.max_speed;
            agent.velocity.2 = (agent.velocity.2 / speed) * agent.max_speed;
        }
        
        idx += 1;
    }
}

/// Generative physics system: Orbital entities orbit around the Player's position.
/// The Player acts as the gravitational center of the galaxy.
pub fn generative_physics_system(
    mut commands: Commands,
    mut query: Query<(Entity, &mut Transform, &mut PhysicsType, Option<&BirthAge>, Option<&DeathAge>, Option<&SteeringAgent>, Option<&TargetLock>)>,
    player_query: Query<(&Transform, &EntityType), Without<PhysicsType>>,
    all_entities_query: Query<(Entity, &Transform), Without<PhysicsType>>,
) {
    // First pass: find the player's position (no longer used for centering, but kept for future proximity logic)
    let mut _px: f32 = 0.0;
    let mut _py: f32 = 0.0;
    for (transform, ent_type) in player_query.iter() {
        if ent_type.0 == "player" {
            _px = transform.x;
            _py = transform.y;
            break;
        }
    }

    // Second pass: update all non-static entities relative to the Sun (0,0,0)
    for (entity, mut transform, mut phys, birth_age, death_age, steering, target_lock_opt) in query.iter_mut() {
        let birth_factor = birth_age.map_or(1.0, |b| (b.0 / 2.0).min(1.0));

        // Death Implosion effect (pull towards center 0,0,0)
        if let Some(age) = death_age {
            let death_factor = (age.0 / 0.5).min(1.0);
            transform.z *= 1.0 - death_factor;
            transform.x *= 1.0 - death_factor * 0.1;
            transform.y *= 1.0 - death_factor * 0.1;
        }

        match *phys {
            PhysicsType::Static => {}
            PhysicsType::Orbital { radius, speed, ref mut angle } => {
                *angle += speed * birth_factor * 0.016;
                // Heliocentric Orbit
                let target_x = angle.cos() * radius;
                let target_y = angle.sin() * radius;
                
                if let Some(agent) = steering.as_ref() {
                    if agent.behavior != "idle" {
                        transform.x += agent.velocity.0 * 0.016 * 60.0;
                        transform.y += agent.velocity.1 * 0.016 * 60.0;
                        transform.z += agent.velocity.2 * 0.016 * 60.0;
                        continue;
                    }
                }
                // Lerp back to orbit if returning from steering
                transform.x += (target_x - transform.x) * 0.1;
                transform.y += (target_y - transform.y) * 0.1;
            }
            PhysicsType::Sinusoidal { amplitude, frequency, ref mut time } => {
                *time += 0.016;
                let target_z = (*time * frequency).sin() * amplitude * birth_factor;
                
                if let Some(agent) = steering.as_ref() {
                    if agent.behavior != "idle" {
                        transform.x += agent.velocity.0 * 0.016 * 60.0;
                        transform.y += agent.velocity.1 * 0.016 * 60.0;
                        transform.z += agent.velocity.2 * 0.016 * 60.0;
                        continue;
                    }
                }
                
                transform.x += 25.0 * birth_factor * 0.016;
                if transform.x > 1000.0 { transform.x = -1000.0; }
                transform.z += (target_z - transform.z) * 0.1;
            }
            PhysicsType::Projectile { speed } => {
                if let Some(t_lock) = target_lock_opt {
                    let mut found_target_pos = None;
                    for (e2, t2) in all_entities_query.iter() {
                        if e2.index() == t_lock.0 {
                            found_target_pos = Some((t2.x, t2.y));
                            break;
                        }
                    }

                    if let Some((tx, ty)) = found_target_pos {
                        let dx = tx - transform.x;
                        let dy = ty - transform.y;
                        let target_angle = dy.atan2(dx);
                        
                        let mut angle_diff = target_angle - transform.rotation;
                        while angle_diff > std::f32::consts::PI { angle_diff -= std::f32::consts::TAU; }
                        while angle_diff < -std::f32::consts::PI { angle_diff += std::f32::consts::TAU; }
                        
                        transform.rotation += angle_diff * 0.05;
                    } else {
                        commands.entity(entity).remove::<TargetLock>();
                    }
                }

                transform.x += transform.rotation.cos() * speed;
                transform.y += transform.rotation.sin() * speed;
            }
        }
    }
}

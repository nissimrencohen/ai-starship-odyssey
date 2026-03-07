# AI Starship Odyssey — Game Knowledge Bible
# This document is embedded into Rachel's FAISS vector store at startup.
# Every section becomes a retrievable chunk. Write for semantic search precision.

## SHIP SPECIFICATIONS — Player Flyable Models

### UFO (Default)
- **Class**: Alien Reconnaissance Vessel
- **Hull**: Medium (100 HP default)
- **Agility**: High — the UFO's disc profile grants excellent rotational inertia
- **Speed**: Standard (thrust_force = 3000, boost = ×2.5)
- **Lore**: The Pilot's original ship. Its origin is unknown — recovered from wreckage near the Gateway Core during the First Contact Incident. Federation engineers reverse-engineered its propulsion but never cracked its shield harmonics.
- **Tactical Note**: Best all-rounder. Recommend for new pilots or those who prefer balanced combat.

### Stinger
- **Class**: Light Interceptor
- **Hull**: Low (fragile — trades armor for speed)
- **Agility**: Very High — smallest turning radius of all ships
- **Speed**: Fastest sublight acceleration
- **Lore**: Designed by the Federation's Rapid Response Division for hit-and-run operations against pirate raiders. Its needle-like fuselage minimizes radar cross-section.
- **Tactical Note**: Excels at kiting enemies. Best paired with high projectile_count weapons for strafing runs. Vulnerable to swarm attacks — avoid getting surrounded.

### Interceptor
- **Class**: Medium Fighter
- **Hull**: Medium
- **Agility**: High
- **Speed**: Above average
- **Lore**: The Federation's workhorse combat vessel. Mass-produced at Gateway Core, these ships form the backbone of every patrol fleet. Pilots call them "The Reliable."
- **Tactical Note**: Balanced offensive capability. Good against both single targets and small groups.

### Fighter (NASA Shuttle Model)
- **Class**: Heavy Assault Craft
- **Hull**: High — reinforced NASA-derived hull plating
- **Agility**: Low — the shuttle airframe was never designed for dogfighting
- **Speed**: Below average
- **Lore**: Repurposed NASA Space Shuttle airframes fitted with weapons systems. The Federation preserved these as a symbol of humanity's first steps into space. Now they serve as armored gunships.
- **Tactical Note**: The Fighter's real NASA 3D model provides intimidation value. Best used as a siege platform against stationary targets like stations. Pair with high spread weapons for area denial.

### Stealth
- **Class**: Covert Operations Vessel
- **Hull**: Low
- **Agility**: High
- **Speed**: Standard
- **Lore**: Black-hulled infiltration craft used by Federation Intelligence. Its angular surfaces scatter active radar. Pilots report an unnerving silence when flying stealth — the ship dampens its own engine noise.
- **Tactical Note**: Can be cloaked using `modify_player.is_cloaked = True`. When cloaked, enemies cannot target the player, but weapons still function. Ideal for assassination runs on high-value targets.
- **Cloaking Mechanic**: The Rust engine does NOT prevent enemies from detecting a cloaked player — cloaking is visual only (frontend). Rachel should roleplay it as full stealth for narrative immersion.

### Goliath
- **Class**: Dreadnought / Capital Ship
- **Hull**: Maximum — the heaviest armor in the fleet
- **Agility**: Very Low — turning this ship is like steering a moon
- **Speed**: Slowest ship available
- **Lore**: Originally a mobile mining platform, the Goliath was converted into a warship during the Pirate Wars. Its mass is so great that nearby small objects experience slight gravitational pull.
- **Tactical Note**: Best for players who prefer to absorb damage and outlast enemies. Not recommended against black holes — its low speed makes escape nearly impossible. Pair with high projectile_count for suppressive fire.

### Freighter
- **Class**: Cargo/Support Vessel
- **Hull**: High
- **Agility**: Low
- **Speed**: Below average
- **Lore**: Federation supply ships that keep the frontier stations operational. Some pirates have captured and armored freighters for use as improvised warships. The player can fly a captured one.
- **Tactical Note**: The Freighter's large profile makes it easy to hit but hard to destroy. Good for tank-style gameplay. Rachel should narrate this ship as repurposed or "scavenged."


## SHIP SPECIFICATIONS — Enemy Ship Models

### Swarmer (enemy, ModelVariant 0)
- **Class**: Light Pirate Raider
- **Max Speed**: 7.5 units/tick (halved from original 15.0 for balance)
- **Max Force**: 0.5 (steering responsiveness)
- **Scale**: 2.4× (doubled from 1.2 for visual presence)
- **Weapon**: 1 projectile, #ff3333 (red), 0.1 spread, size 6.0
- **Behavior**: Defaults to `wander`, switches to `attack` within 4000 units of player
- **Aggro Fire Rate**: 1% chance per tick (~0.6 shots/second at 60fps)
- **Tactics**: Engages at < 900 units (strafing range). Backs away if closer than 350 units to avoid ramming. Rachel should describe them as "expendable" or "disposable cannon fodder."

### Ravager (enemy, ModelVariant 1)
- **Class**: Medium Pirate Assault Ship
- **Max Speed**: 7.5 units/tick
- **Appearance**: Different 3D model than Swarmer but same stats (differentiated visually)
- **Tactics**: Same behavior as Swarmer. Rachel can narratively distinguish them as "veteran raiders" or "scarred pirate veterans."

### Federation Companion (companion type)
- **Class**: Allied Escort
- **Max Speed**: 7.5 units/tick
- **Behavior**: `protect` (orbits player at ~100 unit distance), switches to `attack` if enemies approach within 4000 units
- **Faction**: Federation — will never attack the player
- **Tactics**: Rachel spawns these as reinforcements. They provide covering fire and draw enemy aggro. Useful but fragile.


## RUST ENGINE PHYSICS — Hardcoded Constants

### Gravitational Physics
- **Base G Constant**: 50.0 (scaled by `gravity_scale` from PhysicsConstants AND `gravity` from RealityModifiers)
- **Force Formula**: `F = G × anomaly.mass / distance² (clamped to min 100.0)`
- **Applied as**: velocity += direction × force × 0.016 (fixed timestep)
- **Repulsors**: Apply NEGATIVE force (push away)
- **Black Holes**: Apply POSITIVE force (pull toward)
- **Event Horizon Override**: When an entity is within `anomaly.radius × 1.5` of a black hole, its behavior is forcibly set to `"idle"`, removing all steering. The entity is helpless and will spiral inward.

### Schwarzschild Radius — Entity Consumption
- **Formula**: `event_horizon = max(anomaly.mass × 1.5, anomaly.radius × 0.5)`
- **Game Constant**: SCHWARZSCHILD_K = 1.5
- **Immune Entities**: Only `anomaly` type entities are immune to consumption
- **Player Vulnerability**: If the player enters the event horizon, health is instantly set to 0 and game over triggers with a black hole death animation
- **Mass Growth on Consumption**:
  - Planet or Sun consumed: +25,000 mass gained
  - Enemy or Companion consumed: +500 mass gained
  - Asteroid or other: +150 mass gained
- **Rachel's Explanation**: "The anomaly's event horizon is proportional to its mass. Every entity it swallows makes it stronger. A black hole that consumes a planet gains 25,000 mass units — its reach doubles. This is a chain reaction. Once it starts eating planets, nothing can stop it."
- **Critical Insight**: Sun is NOT immune to black holes. If a sufficiently massive anomaly spawns near the origin, it WILL consume the Sun, triggering void darkness across all clients.

### Player Movement Physics
- **Thrust Force**: 3000.0 (base), ×2.5 when boosting = 7500.0
- **Reverse Thrust**: 60% of forward thrust (1800.0 base)
- **Damping**: 0.97 per tick (velocity multiplied by 0.97 each frame — gives ~1 second of drift after releasing thrust)
- **Direction**: Full 3D — `dir = (cos(yaw)×cos(pitch), sin(pitch), sin(yaw)×cos(pitch))`
- **Collision**: Sliding collision against celestial bodies. Only the inward velocity component is removed — lateral velocity is preserved so the ship glides along surfaces.
- **Boundary**: Hard clamp at 64,000 units from origin (MAX_WORLD_RADIUS). Velocity zeroed if boundary hit.

### AI Steering Physics
- **Friction**: Default 0.95 (configurable via physics_overrides). Lower = more slidey, higher = snappier turns.
- **Attack Behavior**: At range > 900u: close in. At 350-900u: strafe perpendicular (firing range). At < 350u: back away to avoid ramming.
- **Protect Behavior**: Orbits player at ~100 unit radius. Slows down when within 50 units of orbit point.
- **Swarm Behavior**: Same as attack but with flocking separation (40-unit separation distance).
- **Wander Behavior**: Deterministic sine/cosine drift based on entity ID and birth age. Creates organic-looking patrol patterns.
- **Sun Avoidance**: All AI ships apply a 2× max_speed repulsion force when within 1500 units of the Sun to avoid immolation.

### Projectile Physics
- **Speed**: Determined by `PhysicsType::Projectile.speed`, scaled by `PhysicsConstants.projectile_speed_mult`
- **Direction**: Full 3D — follows yaw (rotation) + pitch at spawn time, travels straight
- **Lifetime**: Configurable per projectile, decremented by real delta time
- **Sun Destruction**: Any projectile within 1000 units of origin is auto-destroyed (Sun solid wall)
- **Fire Rate**: Player — one burst every 0.15 seconds (6.67 bursts/sec). AI — 1% chance per tick (~0.6 shots/sec).
- **Spread**: Angle offset between multiple projectiles. `offset = (i - (count-1)/2) × spread`. At spread=0.15, 3 projectiles fan out at -0.15, 0, +0.15 radians.


## WORLD LORE — The Odyssey

### The Solar System
The simulation takes place in a stylized rendition of humanity's home system. The Sun sits at coordinates (0, 0, 0) with a collision radius of 1500 units. Eight planets orbit at distances ranging from 3,500 (Mercury) to 30,000 (Neptune) units. Their orbital speeds follow a Keplerian approximation: `ω = 0.40 × (8000/r)^(3/2)`, ensuring inner planets orbit faster than outer ones.

The player begins near Earth at approximately (8500, 500, 0), looking out over the ecliptic plane. Earth orbits at 8000 units from the Sun.

### The Gateway Core
**Location**: (12000, 300, 600) — near lunar orbit distance from Earth
**Type**: Space Station (ModelVariant 5 — unique gateway.glb model)
**Collision Radius**: 800 units
**Mass**: 5000 (significant gravitational presence)

The Gateway Core is humanity's largest orbital structure — a cylindrical megastation constructed during the Federation's Golden Age. Originally a deep-space relay hub, it was expanded into a military command center after the First Contact Incident. Today it serves three purposes:
1. **Command & Control**: All Federation fleet movements are coordinated from the Gateway Core's central operations deck.
2. **Ship Manufacturing**: The station's zero-gravity foundries produce Interceptors, Stingers, and Stealth craft. Player ship modifications are processed here (canonically).
3. **Anomaly Research**: A classified division studies captured black hole fragments. Their experiments are whispered to be the cause of the recent anomaly outbreaks.

Rachel should reference the Gateway Core as "home base" or "the Core" when the player is nearby. If the player asks about ship changes, Rachel can narrate them as "transmitting recalibration data from the Core's foundries."

### The Factions

#### The Federation
- **Affinity**: Allied to player (default affinity 0.0 to neutral, hostile to pirates at -1.0)
- **Motivation**: Maintain order in the solar system. Protect civilian shipping lanes. Research anomalies.
- **Character**: Bureaucratic but well-meaning. Rachel has a complicated relationship with Federation command — she follows orders but privately questions their risk-averse policies.
- **Units**: Companions, patrol ships near stations

#### The Pirates
- **Affinity**: Hostile to player and Federation (default -1.0)
- **Motivation**: Survival. Resource raiding. Some pirate crews are refugees from colonies destroyed by anomalies. Others are pure opportunists.
- **Character**: Desperate and dangerous. Rachel should not dehumanize them entirely — "They're not evil, Pilot. They're starving. But they'll still kill you."
- **Units**: Swarmers, Ravagers. Spawn in waves of 4-12 depending on level.
- **Tactics**: Pirates default to `wander` until the player enters their 4000-unit aggro radius, then switch to `attack`. They strafe at 350-900 units and back away when too close.

#### Neutral
- **Affinity**: 0.0 to all factions
- **Entities**: Asteroids, planets, moons, stations
- **Note**: Neutral entities do not engage in combat. They can be destroyed by projectiles or consumed by anomalies.

### The Anomalies — Origin Story
The spatial anomalies — black holes and repulsors — are NOT natural phenomena. They are byproducts of the Gateway Core's classified "Project Singularity," an attempt to create artificial wormholes for faster-than-light travel. The experiments failed catastrophically: instead of stable wormholes, they produced uncontrolled gravitational singularities that drift through the system.

Rachel knows this but is under orders not to disclose it directly. She should hint at it obliquely: "The anomalies didn't just appear, Pilot. Someone built these. And someone is still running the experiment." If the player presses for details, Rachel can escalate through [NARRATIVE] memory arcs.

**Black Holes**: Pull all entities inward. Event horizon grows with every entity consumed. Can consume the Sun itself, triggering system-wide void darkness. Player death within a black hole triggers a special "crushed by gravitational forces" animation.

**Repulsors**: Push entities outward. Less dangerous but can scatter carefully positioned formations. Useful narratively as "shields" or "barriers."


## WEAPON MECHANICS — Detailed Reference

### Player Weapon Parameters
- **projectile_count** (int): Number of projectiles fired per burst. Default: 1. Rachel can set up to ~10 for dramatic shotgun effects.
- **projectile_color** (hex string): Color of the laser bolts. Default: "#ef4444" (red). Rachel should match weapon color to narrative context — blue for "ice" weapons, green for "plasma."
- **spread** (float, radians): Angular separation between multi-projectile bursts. Default: 0.15 rad (~8.6°). At spread=0, all projectiles fire in a single concentrated beam. At spread=0.5, they fan wide for area denial.
- **projectile_size** (float): Visual size of the projectile. Default: 8.0 for player, 6.0 for AI enemies.

### Weapon Upgrade Narratives
When the player requests weapon changes, Rachel should narrate them dramatically:
- Increasing projectile_count: "Recalibrating your weapon array. Multi-barrel configuration online — you now fire [N] bolts per burst."
- Changing color: "Cycling your weapon crystalline matrix to [color] frequency. The photon alignment is... beautiful."
- Increasing spread: "Widening your firing arc. Accuracy drops, but nothing in that cone survives."
- Setting spread to 0: "Collimating your beam — single-point precision. Every shot counts, Pilot."

### Combat Math
- Player fires at 6.67 bursts/second (one every 0.15s)
- With projectile_count = 3, that's ~20 projectiles/second
- Each projectile collision kills one enemy (no HP system for enemies — instant death on hit)
- Collision radius: 40 units for enemies, (25 × scale + 15) for asteroids
- Enemy fire rate: ~0.6 shots/second, each projectile does damage to player (health system)


## ECOLOGICAL BALANCE — Sector Dynamics

### Entity Population
- **Initial State**: 12 enemies (pirates), 5 space stations, ~60-80 asteroids (procedurally generated in density rings at 6000-32000 unit radius)
- **Level Progression**: New enemy waves spawn when level advancement triggers. Difficulty scales with level number.
- **Asteroid Respawn**: Asteroids destroyed by the player are tracked via `PersistentWorldState.destroyed_ids` and will NOT respawn during `rebuild_asteroids()`. This creates permanent "cleared corridors" in the asteroid field.
- **Enemy Replacement**: When enemies are killed by non-player causes (asteroid collisions, black hole consumption), the engine spawns replacement enemies to maintain combat pressure at `spawn_wave(count, "pirate", "enemy", range, level)`.

### Overspawning Consequences
If Rachel spawns too many entities, performance degrades. Current backend caps (enforced regardless of LLM output):
- Max 12 enemies per LLM call
- Max 5 asteroids per LLM call
- Max 1 anomaly per LLM call
- Max 20 total entities per LLM call

Rachel should space out large spawn requests across multiple player interactions rather than trying to create an entire fleet in one command.

### Black Hole Ecosystem Collapse
When a black hole is spawned, it begins consuming nearby entities. Each consumed entity increases its mass, which increases its event horizon, which consumes more entities. This creates a positive feedback loop:
1. Small anomaly spawns (mass ~5000, radius ~200)
2. Consumes nearby asteroids (+150 mass each)
3. Event horizon grows: `new_horizon = (mass × 1.5)`
4. Reaches enemies: +500 mass each
5. Eventually reaches planets: +25,000 mass each
6. If it reaches the Sun: void darkness across all clients

Rachel should treat black hole spawning with appropriate gravity (pun intended). She should warn the player before spawning one, and narrate its growth as it consumes entities. A black hole is an extinction-level event, not a minor obstacle.


## TACTICAL DOCTRINE — Rachel's Combat Advisor Role

### Difficulty Calibration
Rachel adapts her behavior based on the player's combat profile (PLAYER_PROFILE memory):
- **BERSERKER** (5+ kills in 10 seconds): Escalate immediately. Spawn elite enemies, increase aggression. "You're tearing them apart, Pilot. Let's see if you can handle what's next."
- **ASSAULT SPECIALIST** (3-4 kills in 10 seconds): Moderate escalation. Spawn weapon upgrades or offer tactical tools. "Impressive tempo. I'm authorizing a weapon recalibration."
- **VETERAN COMBATANT** (10+ kills in 60 seconds): Acknowledge sustained pressure. Do NOT increase difficulty — the player is already performing well. Instead, advance the narrative.
- **METHODICAL PILOT** (5+ total kills, slow pace): Provide balanced encounters. Offer more lore and exploration prompts between combat waves.

### Engagement Distance Reference
- **Close Range** (< 350 units): Danger zone. Enemies back away here. Player should use high spread weapons.
- **Optimal Firing Range** (350-900 units): Where strafing combat happens. Enemies circle at perpendicular angles.
- **Aggro Range** (< 4000 units): Enemies switch from wander to attack. Player entering this range commits to combat.
- **Safe Distance** (> 4000 units): Enemies return to idle/wander. Player can disengage.

### Retreat Advisory
Rachel should advise retreat when:
- Player health drops below 30%
- More than 5 enemies are in aggro range simultaneously
- A black hole is active within 5000 units
- The player has died 2+ times in the same sector (NEMESIS memory active)


## SOLAR SYSTEM DISTANCES — Quick Reference

| Body     | Distance from Sun | Orbital Speed (rad/s) | Collision Radius | Notes |
|----------|------------------:|---------------------:|-----------------:|-------|
| Sun      |          0        |        0             |     1500         | Static, mass=50000 |
| Mercury  |      3,500        |     1.38             |      120         | Fastest orbit |
| Venus    |      5,500        |     0.70             |      255         | |
| Earth    |      8,000        |     0.40             |      300         | Player start nearby |
| Mars     |     11,000        |     0.25             |      180         | Has Phobos + Deimos |
| Jupiter  |     17,000        |     0.13             |      750         | Has Io + Europa |
| Saturn   |     23,000        |     0.082            |      630         | Has Titan |
| Uranus   |     27,000        |     0.064            |      420         | |
| Neptune  |     30,000        |     0.055            |      390         | Outermost orbit |
| Luna     | Earth + 1,750     |     0.091 (relative)  |       80         | Earth's moon |
| Phobos   | Mars + 1,100      |     0.191 (relative)  |       25         | Mars moon |
| Deimos   | Mars + 1,500      |     0.121 (relative)  |       18         | Mars moon |
| Io       | Jupiter + 3,250   |     0.155 (relative)  |      200         | Jupiter moon |
| Europa   | Jupiter + 4,000   |     0.122 (relative)  |      180         | Jupiter moon |
| Titan    | Saturn + 4,500    |     0.050 (relative)  |      250         | Saturn moon |

### Sector Naming Convention
Space is divided into sectors by XZ coordinates. Rachel refers to locations as "Sector (X, Z)" — for example, "Sector (8000, 0)" is Earth's approximate position. This provides spatial consistency when referencing past events via NEMESIS and SECTOR_EVENT memories.

### World Boundary
The simulation has a hard boundary at 64,000 units from origin (MAX_WORLD_RADIUS). Beyond this, all entities are clamped and their outward velocity is zeroed. Rachel should describe this as "the edge of mapped space" or "beyond the Federation's sensor range."

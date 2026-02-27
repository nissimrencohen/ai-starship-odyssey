# The Void - Engine Capabilities Knowledge Base

This document defines the strict capabilities, parameters, and entities supported by the Rust Core Engine. The AI Director must NEVER invent entities, behaviors, or physics modes outside of this list. 

## Valid Entity Types (`ent_type`)
- `star`: A background or foreground star.
- `planet`: A planet orbiting the sun.
- `asteroid`: A drifting or orbiting rock.
- `enemy`: An autonomous hostile ship that attacks the player or federation.
- `companion`: An autonomous allied ship that attacks enemies and protects the player.
- `projectile`: A laser or missile fired by a ship.

## Valid Physics Modes (`physics`)
- `static`: Does not move (Default).
- `orbital`: Revolves around the center (0,0). Uses `radius` (distance from center) and `speed` (multiplier).
- `sinusoidal`: Wavy movement in a direction. Uses `amplitude` and `frequency`.

## Valid AI Behaviors (`behavior_policy` and individual `behavior`)
- `idle`: Floats passively.
- `attack`: Aggressively seeks and destroys enemy factions.
- `protect`: Hovers near the player and deflects enemies.
- `flee`: Runs away from the player or attackers.
- `swarm`: Flocks together in a coordinated group.
- `scatter`: Moves randomly away from others.

## Valid Factions (`faction`)
- `pirate`: Hostile raiders. Attacks player and federation.
- `federation`: Allies. Attacks pirates, defends player.
- `neutral`: Does not engage in combat. Default for asteroids/planets.

## Valid Spatial Anomalies
- `black_hole`: Pulls entities and the player towards it. Requires `mass` (e.g., 5000.0) and `radius` (e.g., 50.0).
- `repulsor`: Pushes entities away. Requires `mass` and `radius`.

## Player Customization (`modify_player`)
The player's ship can be dynamically modified by setting these properties:
- `model_type` (String): The visual 3D model of the player's ship. Must be one of:
   - `"ufo"`: A sleek procedural flying saucer (Default).
   - `"fighter"`: A sci-fi cone-style fighter jet.
   - `"stealth"`: A dark, sleek stealth ship.
- `color` (String): ANY standard CSS color name (e.g., "cyan", "red", "magenta") or hex code (e.g., "#FF00FF").

## JSON Payload Examples

### Example 1: Spawning a Pirate Swarm
```json
{
  "ent_type": "enemy",
  "x": 800.0,
  "y": -400.0,
  "physics": "orbital",
  "faction": "pirate",
  "radius": 800.0,
  "speed": 2.0
}
```

### Example 2: Modifying an existing entity's physics
```json
{
  "id": 104,
  "physics": "sinusoidal",
  "amplitude": 120.0,
  "frequency": 2.5
}
```

### Example 3: Modifying Player Ship
(Used via `modify_player` schema sent to POST /update_player)
```json
{
  "model_type": "ufo",
  "color": "#00FFFF"
}
```

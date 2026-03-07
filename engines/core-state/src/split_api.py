import os

def extract_api_structs(source_file, target_file):
    with open(source_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()
        
    api_lines = []
    
    api_imports = """use serde::{Deserialize, Serialize};

"""
    api_lines.append(api_imports)

    blocks = [
        (50, 185), # structs from EntityData up to RenderFrameState
    ]
    
    for start, end in blocks:
        b_lines = lines[start-1:end]
        api_lines.extend(b_lines)
        for i in range(start-1, end):
            lines[i] = ""

    # Make structs pub
    api_text = "".join(api_lines)
    api_text = api_text.replace("struct EntityData", "pub struct EntityData")
    api_text = api_text.replace("struct SpawnEntityRequest", "pub struct SpawnEntityRequest")
    api_text = api_text.replace("struct DespawnRequest", "pub struct DespawnRequest")
    api_text = api_text.replace("struct ModifyRequest", "pub struct ModifyRequest")
    api_text = api_text.replace("struct SetPlanetRadiusRequest", "pub struct SetPlanetRadiusRequest")
    api_text = api_text.replace("struct PhysicsUpdateRequest", "pub struct PhysicsUpdateRequest")
    api_text = api_text.replace("struct FactionPairUpdate", "pub struct FactionPairUpdate")
    api_text = api_text.replace("struct CollisionEvent", "pub struct CollisionEvent")
    api_text = api_text.replace("struct SpatialGrid", "pub struct SpatialGrid")
    api_text = api_text.replace("struct ParticleData", "pub struct ParticleData")
    api_text = api_text.replace("struct RenderFrameState", "pub struct RenderFrameState")
    
    # Also add pub to fields
    api_text = api_text.replace("    id: u32,", "    pub id: u32,")
    api_text = api_text.replace("    x: f64,", "    pub x: f64,")
    api_text = api_text.replace("    y: f64,", "    pub y: f64,")
    api_text = api_text.replace("    z: f64,", "    pub z: f64,")
    # Actually just a regex to make all fields pub
    import re
    api_text = re.sub(r"^(\s+)(?!pub)([a-zA-Z_]+):\s*(.+),", r"\1pub \2: \3,", api_text, flags=re.MULTILINE)

    with open(target_file, "w", encoding='utf-8') as f:
        f.write(api_text)
        
    lines.insert(0, "pub mod api;\n")

    with open(source_file, "w", encoding="utf-8") as f:
        f.writelines(lines)
        
    print(f"Extracted API structs to {target_file}")

if __name__ == "__main__":
    extract_api_structs("main.rs", "api.rs")

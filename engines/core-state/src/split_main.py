import os

def extract_world():
    with open("main.rs", "r") as f:
        lines = f.readlines()
    
    world_lines = []
    main_lines = []
    
    in_world = False
    in_api = False
    
    for i, line in enumerate(lines):
        # We need to extract world methods:
        # spawn_wave, spawn_anomaly, SnapshotEntity, Snapshot, save_world_to_disk, rebuild_asteroids
        pass

extract_world()

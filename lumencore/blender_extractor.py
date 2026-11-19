import bpy
import sys
import os
import json
import math
from mathutils import Vector

def get_args():
    argv = sys.argv
    if "--" not in argv:
        return None
    idx = argv.index("--")
    return argv[idx + 1:]

def blender_to_gltf_vec(vec):
    return [float(vec.x), float(vec.z), float(-vec.y)]

def is_hidden_in_render(obj):
    if obj.hide_render:
        return True
    if obj.users_collection:
        if all(col.hide_render for col in obj.users_collection):
            return True
    return False

def is_volume_only_object(obj):
    if obj.type != 'MESH' or not obj.data or not obj.data.materials:
        return False
    found_any_mat = False
    for mat in obj.data.materials:
        if not mat or not mat.use_nodes or not mat.node_tree:
            return False
        found_any_mat = True
        has_volume = False
        has_surface = False
        for node in mat.node_tree.nodes:
            if node.type == 'OUTPUT_MATERIAL':
                if node.inputs['Volume'].is_linked:
                    has_volume = True
                if node.inputs['Surface'].is_linked:
                    has_surface = True
        if not (has_volume and not has_surface):
            return False
    return found_any_mat

def extract_volume_params(obj):
    density = 0.015
    color = [0.22, 0.14, 0.08]
    for mat in obj.data.materials:
        if mat and mat.use_nodes and mat.node_tree:
            for node in mat.node_tree.nodes:
                if node.type in ('VOLUME_PRINCIPLED', 'VOLUME_SCATTER'):
                    if 'Density' in node.inputs:
                        density = float(node.inputs['Density'].default_value)
                    if 'Color' in node.inputs:
                        c = node.inputs['Color'].default_value
                        color = [float(c[0]), float(c[1]), float(c[2])]
                    return {"density": density, "color": color}
    return {"density": density, "color": color}

def extract_scene(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    glb_path = os.path.join(out_dir, "scene.glb")
    meta_path = os.path.join(out_dir, "scene_meta.json")

    scene = bpy.context.scene

    # 1. Strip render-hidden objects & volume-only cubes
    volume_data = None
    to_remove = []
    for obj in list(scene.objects):
        if obj.type != 'CAMERA' and is_hidden_in_render(obj):
            to_remove.append(obj)
        elif is_volume_only_object(obj):
            if volume_data is None:
                volume_data = extract_volume_params(obj)
            to_remove.append(obj)

    for obj in to_remove:
        bpy.data.objects.remove(obj, do_unlink=True)

    # 2. Fast GLB export
    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format='GLB',
        use_selection=False,
        export_cameras=True,
        export_lights=True,
        export_apply=True,
        export_yup=True,
        export_materials='EXPORT',
        export_normals=True,
        export_tangents=False,
    )

    # 3. Extract Camera metadata (including exact focus target distance)
    cameras = []
    active_cam_name = scene.camera.name if scene.camera else None
    for obj in scene.objects:
        if obj.type == 'CAMERA':
            cam = obj.data
            sensor_fit = cam.sensor_fit
            sensor_size = cam.sensor_height if sensor_fit == 'VERTICAL' else cam.sensor_width
            fov_rad = 2.0 * math.atan(sensor_size / (2.0 * cam.lens))

            focus_dist = float(cam.dof.focus_distance)
            if cam.dof.focus_object:
                focus_dist = float((cam.dof.focus_object.matrix_world.translation - obj.matrix_world.translation).length)

            cameras.append({
                "name": obj.name,
                "lens_mm": float(cam.lens),
                "fov_deg": float(math.degrees(fov_rad)),
                "clip_start": float(cam.clip_start),
                "clip_end": float(cam.clip_end),
                "dof_enabled": bool(cam.dof.use_dof),
                "focus_distance": max(focus_dist, 0.5),
                "fstop": float(cam.dof.aperture_fstop),
            })

    # 4. Extract Light metadata (exact direction, area spread, and dimensions)
    lights = []
    for obj in scene.objects:
        if obj.type == 'LIGHT':
            l = obj.data
            radius = 0.25
            size_x = 1.0
            size_y = 1.0
            spread = math.pi * 0.6
            if l.type in ('POINT', 'SPOT'):
                radius = float(getattr(l, 'shadow_soft_size', 0.25))
                if l.type == 'SPOT':
                    spread = float(getattr(l, 'spot_size', math.pi * 0.45))
            elif l.type == 'AREA':
                size_x = float(getattr(l, 'size', 1.0))
                size_y = float(getattr(l, 'size_y', size_x)) if getattr(l, 'shape', 'SQUARE') in ('RECTANGLE', 'ELLIPSE') else size_x
                radius = max(size_x, size_y) * 0.5
                spread = float(getattr(l, 'spread', math.pi * 0.75))
            elif l.type == 'SUN':
                radius = float(getattr(l, 'angle', 0.01))

            world_dir = (obj.matrix_world.to_3x3() @ Vector((0.0, 0.0, -1.0))).normalized()

            lights.append({
                "name": obj.name,
                "type": l.type,
                "energy": float(l.energy),
                "color": [float(l.color.r), float(l.color.g), float(l.color.b)],
                "radius": radius,
                "size_x": size_x,
                "size_y": size_y,
                "spread": spread,
                "position": blender_to_gltf_vec(obj.matrix_world.translation),
                "direction": blender_to_gltf_vec(world_dir),
            })

    # 5. Extract World background
    world_color = [0.005, 0.005, 0.007]
    world_strength = 0.05
    if scene.world:
        if scene.world.use_nodes and scene.world.node_tree:
            for node in scene.world.node_tree.nodes:
                if node.type == 'BACKGROUND':
                    c = node.inputs[0].default_value
                    world_color = [float(c[0]), float(c[1]), float(c[2])]
                    world_strength = float(node.inputs[1].default_value)
                    break
        else:
            c = scene.world.color
            world_color = [float(c[0]), float(c[1]), float(c[2])]

    meta = {
        "scene_name": scene.name,
        "resolution": [int(scene.render.resolution_x), int(scene.render.resolution_y)],
        "active_camera": active_cam_name,
        "cameras": cameras,
        "lights": lights,
        "volume": volume_data,
        "world": {
            "color": world_color,
            "strength": world_strength
        }
    }

    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print("LUMENCORE_EXTRACT_OK")

if __name__ == "__main__":
    args = get_args()
    if args and len(args) >= 1:
        extract_scene(args[0])
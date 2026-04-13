# Pano Prototype

Standalone panorama walkthrough viewer extracted from the engage-web codebase. Uses the same data (CSV + equirectangular JPGs) and replicates the core rendering pipeline in a minimal Vite + Three.js project.

## Running Locally

```bash
cd pano-prototype
npm install
npm run dev
```

Opens at **http://localhost:3000**

### Pano data

The app loads `Office.csv` and the panorama JPGs from `public/panos/`, which is a symlink to the scan data in `planning/pano/`.

Currently pointing at the 2-room subset. To switch to the full 21-pano set:

```bash
rm public/panos
ln -s "../../planning/pano/Office1-21-rooms" public/panos
```

### Usage

1. **Overview mode** — pano positions shown as blue dots on a grid. Click one to enter it.
2. **Pano mode** — drag to look around, scroll to zoom. White discs on the floor mark other pano positions.
3. **Navigate** — click a disc to transition to that pano.
4. **Exit** — press **Esc** or click the back button (top left).

## How It Works — Technical Breakdown

### Data Pipeline

**CSV parsing** (`src/main.js`)

The CSV has scanner coordinates: `filename, x, y, z, qx, qy, qz, qw`

Positions are converted from national grid (scanner Z-up) to Three.js board-local (Y-up):

```
gridCenterX = (minX + maxX) / 2
gridCenterY = (minY + maxY) / 2
gridCenterZ = (minZ + maxZ) / 2

position.x = csv.x - gridCenterX          // east/west, centered
position.y = csv.z - gridCenterZ           // elevation becomes Y (up)
position.z = gridCenterY - csv.y           // northing inverted to Z
```

This matches `engage-web/apps/portal/src/composables/board/processing/panoMapping.ts`.

---

### Sphere Rendering

**Geometry** (`src/PanoViewer.js` — `loadPanos()`)

```
SphereGeometry(radius=20, widthSegments=128, heightSegments=64)
scale(-1, 1, 1)    // invert X so faces point inward (view from inside)
```

- `MeshBasicMaterial` with `side: FrontSide`
- Texture uses `SRGBColorSpace`, `RepeatWrapping` on both axes
- `texture.offset.x = 0.5` (Trimble format alignment)

**How it differs from engage-web geometry:**

Engage-web applies `sphereGeo.rotateX(PI/2)` to the geometry. This rotates the sphere poles from the Y axis to the Z axis, which is a problem because the camera looks in -Z and would see the floor (south pole).

Engage-web compensates by placing the sphere inside a `localSceneGroup` that has `rotateX(-PI/2)`, creating a hierarchy:

```
engage-web hierarchy:
rootGroup (position only, NO rotation)
├── localSceneGroup                    rotateX(-PI/2)
│   └── sphereMesh                     geometry: rotateX(PI/2) + scale(-1,1,1)
│       quaternion: scannerQuat        applied via premultiply
└── navigationGroup                    (no rotation, discs here)
```

The net world-space rotation on any sphere vertex is:

```
world_vertex = Rx(-PI/2) * scannerQuat * Rx(PI/2) * scale(-1,1,1) * original_vertex
```

**The prototype flattens this** — no geometry rotation, no group hierarchy. Instead, the equivalent world rotation is computed as a single quaternion and applied directly to the mesh:

```
prototype approach:
scene
├── sphereGroup
│   └── sphere                         geometry: scale(-1,1,1) only
│       quaternion: Rx(-PI/2) * scannerQuat * Rx(PI/2)
└── discGroup                          (discs here)
```

Both produce identical world-space vertex positions. The advantage of the prototype approach is that the sphere poles stay on the Y axis in local space, so:
- Camera looking in -Z sees the equator (horizon), not the floor
- Polar rotation (up/down drag) maps naturally to looking up/down in the panorama
- No need for a compensating parent group rotation

---

### Quaternion Conversion (Z-up to Y-up)

The scanner quaternion (qx, qy, qz, qw) describes the panorama's orientation in a Z-up coordinate system. Three.js uses Y-up. The conversion is a conjugation by a 90-degree X rotation:

```javascript
q_converted = Rx(-PI/2) * q_scanner * Rx(PI/2)
```

In code:

```javascript
const rxNeg = new Quaternion().setFromAxisAngle(new Vector3(1,0,0), -Math.PI/2);
const rxPos = new Quaternion().setFromAxisAngle(new Vector3(1,0,0),  Math.PI/2);
sphere.quaternion.copy(rxNeg).multiply(scannerQuat).multiply(rxPos);
```

This is mathematically equivalent to the engage-web approach of `localSceneGroup.rotateX(-PI/2)` + `geometry.rotateX(PI/2)` + `mesh.quaternion = scannerQuat`.

---

### Camera Setup

**Two cameras:**
- Overview: `PerspectiveCamera(fov=60)` — orbit view of all pano points
- Pano: `PerspectiveCamera(fov=75, near=0.01, far=100)` — inside the sphere

**Pano camera-controls** (matches engage-web `controls.ts`):

| Setting | Value | Purpose |
|---------|-------|---------|
| dollyToCursor | false | No dolly (rotation only) |
| azimuthRotateSpeed | -0.3 | Horizontal pan speed |
| polarRotateSpeed | -0.3 | Vertical tilt speed |
| minZoom | 0.5 | Minimum zoom (50%) |
| maxZoom | 5 | Maximum zoom (500%) |
| smoothTime | 0.1 | Damping |
| minPolarAngle | 0.1 | Prevent flipping past ceiling |
| maxPolarAngle | PI - 0.1 | Prevent flipping past floor |
| mouse left/middle/right | ROTATE | All mouse buttons rotate |
| mouse wheel | ZOOM | Scroll to zoom |
| touch 1/2/3 | TOUCH_ROTATE | All touch gestures rotate |

**Camera positioning on pano entry** (matches engage-web `centerPano()`):

```javascript
// Camera at sphere centre + tiny Z offset, looking at centre
panoControls.setLookAt(pos.x, pos.y, pos.z + 1e-5, pos.x, pos.y, pos.z, false);

// Deferred orbit point setup (engage-web does this in .then() after animation)
requestAnimationFrame(() => {
  panoControls.setOrbitPoint(pos.x, pos.y, pos.z);
  panoControls.setFocalOffset(0, 0, 0);
});
```

The 1e-5 offset is required because camera-controls cannot orbit when camera and target are at exactly the same point.

---

### Navigation Discs

**Geometry and material:**
```
CircleGeometry(radius=1, segments=32)
MeshBasicMaterial(color=white, opacity=0.2, transparent=true)
```

**Positioning** — disc world position = target pano position, sunk 2 units below:
```
disc.position = (targetPano.x, targetPano.y - 2, targetPano.z)
```

In engage-web, discs are positioned relative to the current pano's group:
```
disc.position = targetPos - currentPos - (0, 2, 0)
```
Since the group is at `currentPos`, the world position is `targetPos - (0, 2, 0)` — identical result.

**Orientation:** `lookAt(x, y+1, z)` — faces upward (flat on the ground plane).

**Interaction:** Raycasting on click detects disc hits. Hover highlights with increased opacity (0.5) and scale (1.3x). Optional pulse animation on idle discs.

---

### Transitions Between Panos

**Engage-web:** Uses `moveTo()` with `keepFacing: true` — camera-controls handles the smooth animation internally. No crossfade — just camera movement.

**Prototype:** Adds a crossfade effect on top:
1. Target sphere fades in (opacity 0 to 1)
2. Current sphere fades out (opacity 1 to 0)
3. Camera position lerps between the two pano centres
4. Viewing direction (azimuth/polar) is preserved
5. Duration and easing are configurable via `CONFIG`

This is a deliberate enhancement over engage-web for prototyping transition effects.

---

## What Matches Engage-Web

| Aspect | Status |
|--------|--------|
| Sphere geometry (radius, segments, inversion) | Identical |
| Texture mapping (offset, wrapping, color space) | Identical |
| World-space sphere orientation (quaternion conversion) | Mathematically equivalent |
| Camera type and FOV | Identical (PerspectiveCamera, 75) |
| Camera-controls settings (all rotation/zoom params) | Identical |
| Camera positioning on entry (EPS offset + deferred orbit) | Equivalent |
| Navigation disc geometry, position, orientation | Identical |
| Coordinate conversion from CSV | Identical |
| Polar angle constraints | Identical |

## What Differs From Engage-Web

| Aspect | Prototype | Engage-Web | Why |
|--------|-----------|------------|-----|
| Sphere rotation approach | Quaternion composition on mesh | Geometry rotation + group hierarchy | Simpler, same visual result |
| Pano entry animation | Instant (false) | Animated (true) | Prototype snaps for faster dev iteration |
| Transition effect | Crossfade + position lerp | Camera-controls animation only | Prototype enhancement for experimentation |
| Disc material | DoubleSide, depthTest off | Defaults (FrontSide, depthTest on) | Ensures discs always visible in prototype |
| Camera near plane | 0.01 | 0.1 (default) | Prototype slightly more permissive |
| Source coord storage | Not stored | Stored as cameraSourcePosition | Needed for point cloud measurement alignment |
| Interaction system | Direct raycasting | Layer-based with priorities | Prototype is simpler |

## Prototyping Areas

Two areas are marked with comment blocks in `PanoViewer.js`:

### 1. Transitions (`CONFIG` + `transitionTo()`)

```javascript
CONFIG.animateTransitions   // toggle crossfade on/off
CONFIG.transitionDuration   // duration in ms
```

Modify `transitionTo()` and `_updateTransition()` to experiment with:
- Dolly-forward effect (zoom in, switch, zoom out)
- Fade to black
- Different easing curves
- Camera path animation

### 2. Disc Styling (`CONFIG` + `_createNavigationDiscs()`)

```javascript
CONFIG.discRadius          // size
CONFIG.discColor           // colour
CONFIG.discOpacity         // base transparency
CONFIG.discHoverOpacity    // hover transparency
CONFIG.discHoverScale      // hover scale multiplier
CONFIG.discPulse           // idle pulse animation
```

Modify `_createNavigationDiscs()` to experiment with:
- Ring geometry instead of filled circle
- Sprite-based icons
- 3D arrow indicators
- Glow/emissive materials
- Bobbing/rotating animations

## File Structure

```
pano-prototype/
├── public/panos/          symlink to scan data (CSV + JPGs)
├── src/
│   ├── main.js            CSV parsing, coordinate conversion, entry point
│   ├── PanoViewer.js       Three.js viewer (sphere, camera, discs, transitions)
│   └── style.css           Minimal UI styles
├── index.html              Shell with version label and UI overlay
├── package.json            three + camera-controls + vite
└── vite.config.js          Dev server on port 3000
```

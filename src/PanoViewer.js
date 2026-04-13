import * as THREE from 'three';
import CameraControls from 'camera-controls';

CameraControls.install({ THREE });

// ================================================================
// CONFIGURATION — tweak these values to prototype ideas
// ================================================================
const CONFIG = {
  // --- Transition (prototyping area #1) ---
  animateTransitions: true,
  transitionDuration: 800, // ms

  // --- Disc styling (prototyping area #2) ---
  discRadius: 1,
  discSegments: 32,
  discColor: 0xffffff,
  discOpacity: 0.2,
  discHoverOpacity: 0.5,
  discHoverScale: 1.3,
  discSinkY: 2, // how far below pano centre the discs sit
  discPulse: true, // subtle pulse animation on discs

  // --- Sphere ---
  sphereRadius: 20,
  sphereWidthSegments: 128,
  sphereHeightSegments: 64,
  textureOffsetX: 0.5, // Trimble: 0.5, Leica: 0.75

  // --- Pano camera ---
  fov: 75,
  rotateSpeed: -0.3,
  zoomMin: 0.5,
  zoomMax: 5,
  smoothTime: 0.1,
};

// ================================================================

export class PanoViewer {
  constructor(container, options = {}) {
    this.container = container;
    this.basePath = options.basePath || '/panos';
    this.panos = new Map();
    this.activePano = null;
    this.mode = 'overview'; // 'overview' | 'pano'
    this._transition = null;
    this._hoveredDisc = null;

    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    this._initRenderer();
    this._initScene();
    this._initCameras();
    this._initControls();
    this._initEvents();
    this._animate();
  }

  // ---------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.container.appendChild(this.renderer.domElement);
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);

    this.pointsGroup = new THREE.Group(); // overview markers
    this.sphereGroup = new THREE.Group(); // pano spheres
    this.discGroup = new THREE.Group(); // navigation discs

    this.scene.add(this.pointsGroup);
    this.scene.add(this.sphereGroup);
    this.scene.add(this.discGroup);

    this.gridHelper = new THREE.GridHelper(50, 50, 0x444466, 0x222244);
    this.scene.add(this.gridHelper);
  }

  _initCameras() {
    const aspect = window.innerWidth / window.innerHeight;

    this.overviewCamera = new THREE.PerspectiveCamera(60, aspect, 0.1, 1000);
    this.overviewCamera.position.set(0, 20, 25);

    this.panoCamera = new THREE.PerspectiveCamera(CONFIG.fov, aspect, 0.01, 100);
    // Camera must start at a non-zero position so camera-controls can compute
    // valid spherical coordinates. (0,0,0) → (0,0,0) is degenerate.
    this.panoCamera.position.set(0, 0, 0.1);
  }

  get camera() {
    return this.mode === 'pano' ? this.panoCamera : this.overviewCamera;
  }

  _initControls() {
    // Overview: standard orbit
    this.overviewControls = new CameraControls(
      this.overviewCamera,
      this.renderer.domElement,
    );
    this.overviewControls.setLookAt(0, 20, 25, 0, 0, 0, false);

    // Pano: rotation + zoom only (matches engage-web controls.ts)
    this.panoControls = new CameraControls(
      this.panoCamera,
      this.renderer.domElement,
    );
    this.panoControls.dollyToCursor = false;
    this.panoControls.draggingSmoothTime = CONFIG.smoothTime;
    this.panoControls.smoothTime = CONFIG.smoothTime;
    this.panoControls.dollySpeed = 2;
    this.panoControls.azimuthRotateSpeed = CONFIG.rotateSpeed;
    this.panoControls.polarRotateSpeed = CONFIG.rotateSpeed;
    this.panoControls.minZoom = CONFIG.zoomMin;
    this.panoControls.maxZoom = CONFIG.zoomMax;
    this.panoControls.mouseButtons.left = CameraControls.ACTION.ROTATE;
    this.panoControls.mouseButtons.middle = CameraControls.ACTION.ROTATE;
    this.panoControls.mouseButtons.right = CameraControls.ACTION.ROTATE;
    this.panoControls.mouseButtons.wheel = CameraControls.ACTION.ZOOM;
    this.panoControls.touches.one = CameraControls.ACTION.TOUCH_ROTATE;
    this.panoControls.touches.two = CameraControls.ACTION.TOUCH_ROTATE;
    this.panoControls.touches.three = CameraControls.ACTION.TOUCH_ROTATE;

    // Constrain vertical rotation — prevents tumbling past the poles
    this.panoControls.minPolarAngle = 0.1; // can't look directly at ceiling
    this.panoControls.maxPolarAngle = Math.PI - 0.1; // can't look directly at floor

    this.panoControls.enabled = false;
  }

  _initEvents() {
    window.addEventListener('resize', () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.overviewCamera.aspect = w / h;
      this.overviewCamera.updateProjectionMatrix();
      this.panoCamera.aspect = w / h;
      this.panoCamera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });

    this.renderer.domElement.addEventListener('click', (e) => this._onClick(e));
    this.renderer.domElement.addEventListener('mousemove', (e) =>
      this._onMouseMove(e),
    );
    document
      .getElementById('back-btn')
      .addEventListener('click', () => this.exitPano());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.mode === 'pano') this.exitPano();
    });
  }

  // ---------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------

  loadPanos(panoData) {
    const loader = new THREE.TextureLoader();

    for (const data of panoData) {
      const id = data.filename;
      const position = new THREE.Vector3(
        data.position.x,
        data.position.y,
        data.position.z,
      );

      // Overview marker
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0x00aaff }),
      );
      marker.position.copy(position);
      marker.userData.panoId = id;
      this.pointsGroup.add(marker);

      // Pano sphere (hidden until entered)
      const sphereGeo = new THREE.SphereGeometry(
        CONFIG.sphereRadius,
        CONFIG.sphereWidthSegments,
        CONFIG.sphereHeightSegments,
      );
      sphereGeo.scale(-1, 1, 1); // invert for viewing from inside

      const texture = loader.load(`${this.basePath}/${data.filename}`);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.offset.x = CONFIG.textureOffsetX;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;

      const sphere = new THREE.Mesh(
        sphereGeo,
        new THREE.MeshBasicMaterial({ map: texture, side: THREE.FrontSide }),
      );
      sphere.position.copy(position);

      // Convert scanner quaternion from Z-up to Three.js Y-up.
      // In engage-web this is done via: localSceneGroup.rotateX(-PI/2)
      // + sphereGeo.rotateX(PI/2) + mesh.quaternion = scannerQuat
      // Net world rotation = Rx(-PI/2) * scannerQuat * Rx(PI/2)
      if (data.quaternion) {
        const scannerQuat = new THREE.Quaternion(
          data.quaternion.x, data.quaternion.y,
          data.quaternion.z, data.quaternion.w,
        );
        const rxNeg = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0), -Math.PI / 2,
        );
        const rxPos = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0), Math.PI / 2,
        );
        sphere.quaternion.copy(rxNeg).multiply(scannerQuat).multiply(rxPos);
      }

      sphere.visible = false;
      this.sphereGroup.add(sphere);

      this.panos.set(id, { id, filename: data.filename, position, sphere, marker, texture });
    }
  }

  // ---------------------------------------------------------------
  // Mode switching
  // ---------------------------------------------------------------

  enterPano(panoId, keepFacing = false) {
    const pano = this.panos.get(panoId);
    if (!pano) return;

    this.activePano = pano;
    this.mode = 'pano';

    // Hide overview
    this.pointsGroup.visible = false;
    this.gridHelper.visible = false;

    // Show only the active sphere
    this.panos.forEach((p) => {
      p.sphere.visible = p.id === panoId;
      p.sphere.material.transparent = false;
      p.sphere.material.opacity = 1;
    });

    this._createNavigationDiscs(pano);

    // Position pano camera — matches engage-web controls.ts centerPano()
    const pos = pano.position;
    const EPS = 1e-5;

    this.overviewControls.enabled = false;
    this.panoControls.enabled = true;

    if (keepFacing) {
      this.panoControls.moveTo(pos.x, pos.y, pos.z + EPS, false);
    } else {
      this.panoControls.setLookAt(
        pos.x, pos.y, pos.z + EPS,
        pos.x, pos.y, pos.z,
        false,
      );
    }
    // Deferred orbit point — matches engage-web (called in .then() after animation)
    requestAnimationFrame(() => {
      this.panoControls.setOrbitPoint(pos.x, pos.y, pos.z);
      this.panoControls.setFocalOffset(0, 0, 0);
    });

    document.getElementById('info').textContent = `Viewing: ${pano.filename}`;
    document.getElementById('back-btn').style.display = 'block';
  }

  exitPano() {
    if (this.mode !== 'pano') return;

    this.mode = 'overview';
    this.activePano = null;

    this.pointsGroup.visible = true;
    this.gridHelper.visible = true;
    this.panos.forEach((p) => {
      p.sphere.visible = false;
    });
    this._clearNavigationDiscs();

    this.panoControls.enabled = false;
    this.overviewControls.enabled = true;

    document.getElementById('info').textContent =
      'Click a point to enter 360 view';
    document.getElementById('back-btn').style.display = 'none';
  }

  // ================================================================
  // TRANSITIONS — prototyping area #1
  //
  // Modify transitionTo() to experiment with different effects.
  // The current implementation crossfades while lerping position.
  // ================================================================

  transitionTo(targetId) {
    const target = this.panos.get(targetId);
    if (!target || !this.activePano) return;

    if (!CONFIG.animateTransitions) {
      // Instant snap (original engage-web behaviour)
      this.enterPano(targetId, true);
      return;
    }

    // Start animated transition
    this._clearNavigationDiscs();

    const azimuth = this.panoControls.azimuthAngle;
    const polar = this.panoControls.polarAngle;

    this._transition = {
      from: this.activePano,
      to: target,
      startTime: performance.now(),
      duration: CONFIG.transitionDuration,
      azimuth,
      polar,
    };

    // Prepare target sphere for crossfade
    target.sphere.visible = true;
    target.sphere.material.transparent = true;
    target.sphere.material.opacity = 0;
    this.activePano.sphere.material.transparent = true;

    this.panoControls.enabled = false;
  }

  _updateTransition() {
    const t = this._transition;
    if (!t) return;

    const elapsed = performance.now() - t.startTime;
    const progress = Math.min(elapsed / t.duration, 1);
    const eased = this._easeInOutCubic(progress);

    // Lerp camera position between panos
    const EPS = 1e-5;
    const pos = new THREE.Vector3().lerpVectors(
      t.from.position,
      t.to.position,
      eased,
    );
    this.panoControls.moveTo(pos.x, pos.y, pos.z + EPS, false);

    // Crossfade sphere materials
    t.from.sphere.material.opacity = 1 - eased;
    t.to.sphere.material.opacity = eased;

    if (progress >= 1) {
      this._finishTransition();
    }
  }

  _finishTransition() {
    const t = this._transition;

    t.from.sphere.visible = false;
    t.from.sphere.material.transparent = false;
    t.from.sphere.material.opacity = 1;

    t.to.sphere.material.transparent = false;
    t.to.sphere.material.opacity = 1;

    this.activePano = t.to;
    this._transition = null;

    const pos = t.to.position;
    const EPS = 1e-5;
    this.panoControls.moveTo(pos.x, pos.y, pos.z + EPS, false);
    this.panoControls.enabled = true;
    requestAnimationFrame(() => {
      this.panoControls.setOrbitPoint(pos.x, pos.y, pos.z);
      this.panoControls.setFocalOffset(0, 0, 0);
    });

    this._createNavigationDiscs(t.to);

    document.getElementById('info').textContent = `Viewing: ${t.to.filename}`;
  }

  // ================================================================
  // NAVIGATION DISCS — prototyping area #2
  //
  // Modify _createNavigationDiscs() to experiment with disc styles:
  //   - geometry (ring, sprite, 3D arrow, etc.)
  //   - material (color, glow, texture)
  //   - animation (pulse, bob, rotate)
  // ================================================================

  _createNavigationDiscs(currentPano) {
    this._clearNavigationDiscs();

    this.panos.forEach((pano) => {
      if (pano.id === currentPano.id) return;

      const geo = new THREE.CircleGeometry(
        CONFIG.discRadius,
        CONFIG.discSegments,
      );

      // ---- Disc material — change this to restyle discs ----
      const mat = new THREE.MeshBasicMaterial({
        color: CONFIG.discColor,
        transparent: true,
        opacity: CONFIG.discOpacity,
        side: THREE.DoubleSide,
        depthTest: false,
      });

      const disc = new THREE.Mesh(geo, mat);

      // Position at target pano location, sunk below centre
      disc.position.set(
        pano.position.x,
        pano.position.y - CONFIG.discSinkY,
        pano.position.z,
      );

      // Face upward
      disc.lookAt(
        disc.position.x,
        disc.position.y + 1,
        disc.position.z,
      );

      disc.renderOrder = 999;
      disc.userData.targetPanoId = pano.id;
      disc.userData.baseScale = 1;

      this.discGroup.add(disc);
    });
  }

  _clearNavigationDiscs() {
    while (this.discGroup.children.length > 0) {
      const disc = this.discGroup.children[0];
      disc.geometry.dispose();
      disc.material.dispose();
      this.discGroup.remove(disc);
    }
    this._hoveredDisc = null;
  }

  // ---------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------

  _onClick(event) {
    this._updateMouse(event);
    this.raycaster.setFromCamera(this.mouse, this.camera);

    if (this._transition) return; // ignore clicks during transition

    if (this.mode === 'overview') {
      const hits = this.raycaster.intersectObjects(
        this.pointsGroup.children,
        true,
      );
      if (hits.length > 0) {
        const panoId = hits[0].object.userData.panoId;
        if (panoId) this.enterPano(panoId);
      }
    } else if (this.mode === 'pano') {
      const hits = this.raycaster.intersectObjects(
        this.discGroup.children,
        true,
      );
      if (hits.length > 0) {
        const targetId = hits[0].object.userData.targetPanoId;
        if (targetId) this.transitionTo(targetId);
      }
    }
  }

  _onMouseMove(event) {
    this._updateMouse(event);
    this.raycaster.setFromCamera(this.mouse, this.camera);

    const canvas = this.renderer.domElement;

    if (this.mode === 'overview') {
      const hits = this.raycaster.intersectObjects(
        this.pointsGroup.children,
        true,
      );
      canvas.style.cursor = hits.length > 0 ? 'pointer' : 'default';
    } else if (this.mode === 'pano') {
      // Reset previously hovered disc
      if (this._hoveredDisc) {
        this._hoveredDisc.material.opacity = CONFIG.discOpacity;
        this._hoveredDisc.scale.setScalar(1);
        this._hoveredDisc = null;
      }

      const hits = this.raycaster.intersectObjects(
        this.discGroup.children,
        true,
      );
      if (hits.length > 0) {
        const disc = hits[0].object;
        disc.material.opacity = CONFIG.discHoverOpacity;
        disc.scale.setScalar(CONFIG.discHoverScale);
        this._hoveredDisc = disc;
        canvas.style.cursor = 'pointer';
      } else {
        canvas.style.cursor = 'grab';
      }
    }
  }

  _updateMouse(event) {
    this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  }

  // ---------------------------------------------------------------
  // Render loop
  // ---------------------------------------------------------------

  _animate() {
    requestAnimationFrame(() => this._animate());

    const delta = this.clock.getDelta();

    // Run transition if active
    this._updateTransition();

    // Pulse navigation discs
    if (this.mode === 'pano' && CONFIG.discPulse && !this._transition) {
      const time = this.clock.getElapsedTime();
      const pulse = CONFIG.discOpacity + Math.sin(time * 2) * 0.05;
      this.discGroup.children.forEach((disc) => {
        if (disc !== this._hoveredDisc) {
          disc.material.opacity = pulse;
        }
      });
    }

    // Update active controls and render
    if (this.mode === 'pano') {
      this.panoControls.update(delta);
      this.renderer.render(this.scene, this.panoCamera);
    } else {
      this.overviewControls.update(delta);
      this.renderer.render(this.scene, this.overviewCamera);
    }
  }

  // ---------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------

  _easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
}

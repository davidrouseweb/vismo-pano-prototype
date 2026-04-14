import * as THREE from 'three';
import CameraControls from 'camera-controls';
import { CONFIG } from './config.js';

CameraControls.install({ THREE });

export class PanoViewer {
  constructor(container, options = {}) {
    this.container = container;
    this.basePath = options.basePath || '/panos';
    this.panos = new Map();
    this.activePano = null;
    this.mode = 'overview'; // 'overview' | 'pano'
    this._transition = null;
    this._hoveredDisc = null;
    this._discAutoHide = CONFIG.discAutoHide;
    this._discAutoHideTimer = null;
    this._discFading = false;
    this._discFadeStart = 0;

    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    this._initRenderer();
    this._initScene();
    this._initCameras();
    this._initControls();
    this._initEvents();
    this._initMinimap();
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

    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      this._pointerDownPos = { x: e.clientX, y: e.clientY };
    });
    this.renderer.domElement.addEventListener('click', (e) => {
      // Ignore clicks that were drags (mouse moved more than 5px)
      if (this._pointerDownPos) {
        const dx = e.clientX - this._pointerDownPos.x;
        const dy = e.clientY - this._pointerDownPos.y;
        if (dx * dx + dy * dy > 25) return;
      }
      this._onClick(e);
    });
    this.renderer.domElement.addEventListener('mousemove', (e) =>
      this._onMouseMove(e),
    );
    document
      .getElementById('back-btn')
      .addEventListener('click', () => this.exitPano());
    document
      .getElementById('disc-autohide-cb')
      .addEventListener('change', (e) => {
        this._discAutoHide = e.target.checked;
        if (this.mode === 'pano') {
          if (this._discAutoHide) {
            this._hideDiscs();
          } else {
            this._cancelDiscFade();
            this._showDiscs();
          }
        }
      });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.mode === 'pano') this.exitPano();
    });
  }

  // ---------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------

  async loadPanos(panoData) {
    const loader = new THREE.TextureLoader();

    // Load all textures in parallel
    const texturePromises = panoData.map((data) =>
      new Promise((resolve) => {
        loader.load(`${this.basePath}/${data.filename}`, resolve);
      }),
    );
    const textures = await Promise.all(texturePromises);

    for (let i = 0; i < panoData.length; i++) {
      const data = panoData[i];
      const texture = textures[i];
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
    document.getElementById('disc-toggle').style.display = 'flex';

    if (this._discAutoHide) {
      this._hideDiscs();
    }
  }

  exitPano() {
    if (this.mode !== 'pano') return;

    this.mode = 'overview';
    this.activePano = null;
    this._cancelDiscFade();

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
    document.getElementById('disc-toggle').style.display = 'none';
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

    // Set orbit point first, then move — avoids a one-frame camera jump
    const pos = t.to.position;
    const EPS = 1e-5;
    this.panoControls.setOrbitPoint(pos.x, pos.y, pos.z);
    this.panoControls.setFocalOffset(0, 0, 0);
    this.panoControls.moveTo(pos.x, pos.y, pos.z + EPS, false);
    this.panoControls.enabled = true;

    this._createNavigationDiscs(t.to);

    if (this._discAutoHide) {
      this._hideDiscs();
    }

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

      // Thin dark outline (1px line around the outer edge)
      const outlinePoints = [];
      for (let i = 0; i <= CONFIG.discSegments; i++) {
        const angle = (i / CONFIG.discSegments) * Math.PI * 2;
        outlinePoints.push(new THREE.Vector3(
          Math.cos(angle) * CONFIG.discRadius,
          Math.sin(angle) * CONFIG.discRadius,
          0,
        ));
      }
      const outlineGeo = new THREE.BufferGeometry().setFromPoints(outlinePoints);
      const outlineMat = new THREE.LineBasicMaterial({
        color: CONFIG.discOutlineColor,
        transparent: true,
        opacity: CONFIG.discOutlineOpacity,
        depthTest: false,
      });

      // Visible white ring outline
      const ringGeo = new THREE.RingGeometry(
        CONFIG.discRadius - CONFIG.discRingWidth,
        CONFIG.discRadius,
        CONFIG.discSegments,
      );
      const ringMat = new THREE.MeshBasicMaterial({
        color: CONFIG.discColor,
        transparent: true,
        opacity: CONFIG.discOpacity,
        side: THREE.DoubleSide,
        depthTest: false,
      });

      // Invisible solid hit area for hover/click
      const hitGeo = new THREE.CircleGeometry(
        CONFIG.discRadius,
        CONFIG.discSegments,
      );
      const hitMat = new THREE.MeshBasicMaterial({
        visible: false,
        side: THREE.DoubleSide,
        depthTest: false,
      });

      const disc = new THREE.Group();
      const outline = new THREE.LineLoop(outlineGeo, outlineMat);
      outline.raycast = () => {}; // exclude from raycasting — lines have a fat hit threshold
      const ring = new THREE.Mesh(ringGeo, ringMat);
      const hitArea = new THREE.Mesh(hitGeo, hitMat);
      disc.add(outline);
      disc.add(ring);
      disc.add(hitArea);

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
      disc.children.forEach((child) => {
        child.geometry.dispose();
        child.material.dispose();
      });
      this.discGroup.remove(disc);
    }
    this._hoveredDisc = null;
  }

  _showDiscs() {
    this.discGroup.visible = true;
    this._discFading = false;
    // Reset ring opacity to base
    this.discGroup.children.forEach((disc) => {
      disc.children[0].material.opacity = CONFIG.discOutlineOpacity;
      disc.children[1].material.opacity = CONFIG.discOpacity;
    });
  }

  _hideDiscs() {
    this.discGroup.visible = false;
    this._discFading = false;
  }

  _showDiscsTemporarily() {
    this._cancelDiscFade();
    this._showDiscs();
    this._discAutoHideTimer = setTimeout(() => {
      this._discFading = true;
      this._discFadeStart = performance.now();
    }, CONFIG.discAutoHideDelay);
  }

  _cancelDiscFade() {
    if (this._discAutoHideTimer) {
      clearTimeout(this._discAutoHideTimer);
      this._discAutoHideTimer = null;
    }
    this._discFading = false;
  }

  _updateDiscFade() {
    if (!this._discFading) return;

    const elapsed = performance.now() - this._discFadeStart;
    const progress = Math.min(elapsed / CONFIG.discFadeDuration, 1);

    this.discGroup.children.forEach((disc) => {
      disc.children[0].material.opacity = CONFIG.discOutlineOpacity * (1 - progress);
      disc.children[1].material.opacity = CONFIG.discOpacity * (1 - progress);
    });

    if (progress >= 1) {
      this._hideDiscs();
    }
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
      // Auto-hide mode: show discs on click if hidden
      if (this._discAutoHide && !this.discGroup.visible) {
        this._showDiscsTemporarily();
        return;
      }

      const discHits = this.raycaster.intersectObjects(
        this.discGroup.children,
        true,
      );
      if (discHits.length > 0) {
        const disc = discHits[0].object.parent;
        const targetId = disc.userData.targetPanoId;
        if (targetId) this.transitionTo(targetId);
        return;
      }

      // Auto-hide mode: clicking empty space with discs visible — hide them
      if (this._discAutoHide && this.discGroup.visible) {
        this._cancelDiscFade();
        this._hideDiscs();
        return;
      }

      // Clicked empty space — find the closest pano in the click direction
      const sphereHits = this.raycaster.intersectObject(
        this.activePano.sphere,
        false,
      );
      if (sphereHits.length > 0) {
        const clickPoint = sphereHits[0].point;
        const currentPos = this.activePano.position;
        const clickDir = new THREE.Vector3().subVectors(clickPoint, currentPos).normalize();

        let closest = null;
        let bestScore = -Infinity;

        for (const [id, pano] of this.panos) {
          if (id === this.activePano.id) continue;
          const panoDir = new THREE.Vector3().subVectors(pano.position, currentPos).normalize();
          const dot = clickDir.dot(panoDir);
          // Only consider panos roughly in the click direction
          if (dot > 0.3 && dot > bestScore) {
            bestScore = dot;
            closest = pano;
          }
        }

        if (closest) this.transitionTo(closest.id);
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
        this._hoveredDisc.children[1].material.opacity = CONFIG.discOpacity;
        this._hoveredDisc = null;
      }

      const hits = this.raycaster.intersectObjects(
        this.discGroup.children,
        true,
      );
      if (hits.length > 0) {
        const disc = hits[0].object.parent;
        disc.children[1].material.opacity = CONFIG.discHoverOpacity;
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

    // Fade out discs in auto-hide mode
    this._updateDiscFade();

    // Pulse navigation discs
    if (this.mode === 'pano' && CONFIG.discPulse && !this._transition && !this._discFading) {
      const time = this.clock.getElapsedTime();
      const pulse = CONFIG.discOpacity + Math.sin(time * 2) * 0.05;
      this.discGroup.children.forEach((disc) => {
        if (disc !== this._hoveredDisc) {
          disc.children[1].material.opacity = pulse;
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

    this._updateMinimap();
  }

  // ---------------------------------------------------------------
  // Minimap
  // ---------------------------------------------------------------

  _initMinimap() {
    this._minimap = document.getElementById('minimap');
    if (!this._minimap) return;

    const dpr = window.devicePixelRatio || 1;
    const size = 180;
    this._minimap.width = size * dpr;
    this._minimap.height = size * dpr;
    this._minimapCtx = this._minimap.getContext('2d');
    this._minimapCtx.scale(dpr, dpr);
    this._minimapSize = size;

    this._minimap.addEventListener('click', (e) => this._onMinimapClick(e));
  }

  _updateMinimap() {
    const ctx = this._minimapCtx;
    if (!ctx || this.panos.size === 0) return;

    const size = this._minimapSize;
    const padding = 20;
    const pointRadius = 5;
    const activeRadius = 7;

    // Clear
    ctx.clearRect(0, 0, size, size);

    // Compute bounds from pano positions (X and Z for top-down view)
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    this.panos.forEach((p) => {
      minX = Math.min(minX, p.position.x);
      maxX = Math.max(maxX, p.position.x);
      minZ = Math.min(minZ, p.position.z);
      maxZ = Math.max(maxZ, p.position.z);
    });

    // Add some margin so points don't sit on the edge
    const rangeX = (maxX - minX) || 1;
    const rangeZ = (maxZ - minZ) || 1;
    const scale = (size - padding * 2) / Math.max(rangeX, rangeZ);

    const toScreen = (pos) => ({
      x: padding + (pos.x - minX) * scale + (size - padding * 2 - rangeX * scale) / 2,
      y: padding + (pos.z - minZ) * scale + (size - padding * 2 - rangeZ * scale) / 2,
    });

    // Store screen positions for click detection
    this._minimapPoints = [];

    // Draw all points
    this.panos.forEach((pano) => {
      const sp = toScreen(pano.position);
      const isActive = this.activePano && this.activePano.id === pano.id;

      this._minimapPoints.push({ id: pano.id, x: sp.x, y: sp.y });

      ctx.beginPath();
      ctx.arc(sp.x, sp.y, isActive ? activeRadius : pointRadius, 0, Math.PI * 2);

      if (isActive) {
        // Draw view cone behind the dot
        if (this.mode === 'pano') {
          const azimuth = this.panoControls.azimuthAngle;
          // Camera-controls azimuth: 0 = looking in -Z. On minimap: -Z is down.
          // Rotate so azimuth 0 points down (PI/2 offset), negate for screen coords.
          const angle = -azimuth - Math.PI / 2;
          const coneRadius = 22;
          const coneSpread = Math.PI / 2.5; // ~72 degree FOV cone

          ctx.beginPath();
          ctx.moveTo(sp.x, sp.y);
          ctx.arc(sp.x, sp.y, coneRadius, angle - coneSpread / 2, angle + coneSpread / 2);
          ctx.closePath();
          ctx.fillStyle = 'rgba(0, 204, 255, 0.15)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(0, 204, 255, 0.4)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Active dot
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, activeRadius, 0, Math.PI * 2);
        ctx.fillStyle = '#00ccff';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.fill();
      }
    });
  }

  _onMinimapClick(e) {
    if (!this._minimapPoints) return;

    const rect = this._minimap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Find closest point within hit radius
    let closest = null;
    let closestDist = 15; // max click distance in px

    for (const pt of this._minimapPoints) {
      const dist = Math.hypot(pt.x - x, pt.y - y);
      if (dist < closestDist) {
        closestDist = dist;
        closest = pt;
      }
    }

    if (!closest) return;

    if (this.mode === 'pano') {
      this.transitionTo(closest.id);
    } else {
      this.enterPano(closest.id);
    }
  }

  // ---------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------

  _easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
}

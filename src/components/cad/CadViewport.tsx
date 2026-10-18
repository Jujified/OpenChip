import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { creasedRenderMesh } from '../../lib/cad/creasedMesh';
import { useCadStore, type DisplayMode } from '../../store/cadStore';
import { useValidationStore } from '../../store/validationStore';
import { useProjectStore } from '../../store/projectStore';
import { getLoft } from '../../lib/loft';
import type { CadPiecePayload } from '../../workers/cadWorker';
import type { ChipParams } from '../../types/project';

/** One of the three canonical axis-aligned views, named by what faces the camera. */
export type AxisView = 'top' | 'front' | 'right';

/** Imperative handle so the export panel can grab a render at any size. */
export interface CadViewportHandle {
  /** Renders the current view to a PNG data URI at `scale`× the on-screen size. */
  snapshot: (scale: number) => string | null;
  frameAll: () => void;
  /** Snaps the camera to look straight down one axis, orthographic, fit to the chip. */
  snapToAxis: (axis: AxisView) => void;
  /** Swaps perspective/orthographic in place, keeping the current view direction. */
  toggleProjection: () => void;
}

/**
 * Ceiling on a snapshot's longest edge.
 *
 * Snapshots are stored inline in the project file and mirrored to the
 * localStorage draft, so an unbounded render is not free — it is megabytes of
 * base64 in a ~5 MB budget. 4096 px is comfortably beyond a full-bleed slide.
 */
const MAX_SNAPSHOT_PX = 4096;


/** Unit vector from the model center to the camera, for each canonical view. */
const AXIS_DIRECTIONS: Record<AxisView, THREE.Vector3> = {
  top: new THREE.Vector3(0, 0, 1),
  front: new THREE.Vector3(0, -1, 0),
  right: new THREE.Vector3(1, 0, 0),
};

/**
 * How much of the model an axis-aligned camera has to cover, in the plane
 * perpendicular to its view direction.
 *
 * Top is a special case: the view direction is parallel to `camera.up`
 * (chip-space +Z), which leaves OrbitControls no roll reference to resolve a
 * screen-right axis from — see the `handlePointerDown` comment in the setup
 * effect for the same singularity from the interaction side. Rather than
 * assume which world axis lands on screen-right, it fits a circle that covers
 * the footprint at any roll.
 */
function axisContentHalfExtents(
  size: THREE.Vector3,
  axis: AxisView,
): { halfWidth: number; halfHeight: number } {
  if (axis === 'top') {
    const radius = Math.hypot(size.x, size.y) / 2;
    return { halfWidth: radius, halfHeight: radius };
  }
  if (axis === 'front') return { halfWidth: size.x / 2, halfHeight: size.z / 2 };
  return { halfWidth: size.y / 2, halfHeight: size.z / 2 }; // right
}

/**
 * Grows a content rectangle to the aspect ratio it will render inside,
 * keeping it fully visible rather than cropping whichever axis is tighter.
 */
function containInAspect(
  contentHalfWidth: number,
  contentHalfHeight: number,
  aspect: number,
): { halfWidth: number; halfHeight: number } {
  if (contentHalfWidth / contentHalfHeight > aspect) {
    return { halfWidth: contentHalfWidth, halfHeight: contentHalfWidth / aspect };
  }
  return { halfWidth: contentHalfHeight * aspect, halfHeight: contentHalfHeight };
}

/**
 * Piece tints, resolved from the design tokens rather than hardcoded.
 *
 * `--accent` is a different hue per colour scheme, so a literal here was the
 * dark-mode purple showing up in light mode too.
 */
/** Re-renders on colour-scheme change so token-derived colours stay correct. */
function useColorScheme(): 'dark' | 'light' {
  const [scheme, setScheme] = useState<'dark' | 'light'>(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light',
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setScheme(query.matches ? 'dark' : 'light');
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return scheme;
}

/** One design token, read off the document root as a Three colour. */
function token(name: string, fallback: string): THREE.Color {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return new THREE.Color(value || fallback);
}

function pieceColors(): Record<string, THREE.Color> {
  const accent = token('--accent', '#6d6aff');
  // The lid reads as the neutral counterpart to the body so the two halves are
  // told apart at a glance without turning the chip into a colour chart.
  const lid = token('--ink-faint', '#9aa0b4');

  return { body: accent, lid, solid: accent, channels: accent };
}

/**
 * Empties a group and frees what its meshes and lines held on the GPU. Three
 * does not free buffers on its own, and a slider drag or a run of warning
 * clicks can churn through dozens of meshes.
 */
function disposeChildren(group: THREE.Object3D): void {
  for (const child of [...group.children]) {
    group.remove(child);
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      child.geometry.dispose();
      const material = child.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
  }
}

export function CadViewport({
  chipParams,
  ref,
}: {
  chipParams: ChipParams;
  ref?: Ref<CadViewportHandle>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  /** Whichever of the two cameras below is currently driving the render. */
  const cameraRef = useRef<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>(null);
  const perspCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const orthoCameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const highlightRef = useRef<THREE.Group | null>(null);
  const keyLightRef = useRef<THREE.DirectionalLight | null>(null);
  const groundRef = useRef<THREE.Mesh | null>(null);
  const framedRef = useRef(false);
  /** Whether the last render was in isolate mode, so the transition is detectable. */
  const wasIsolatingRef = useRef(false);
  /**
   * Forwards to the latest `applyProjection`, so the pointerdown listener
   * registered once in the setup effect always calls the current closure
   * rather than the one captured on mount.
   */
  const applyProjectionRef = useRef<(mode: 'perspective' | 'orthographic') => void>(() => {});
  /**
   * Asks for one frame. The viewport renders on demand rather than in a free
   * loop: an idle chip used to be redrawn sixty times a second, with a
   * transmission pass for the x-ray and glass materials on each, for a picture
   * that had not changed.
   */
  const invalidateRef = useRef<() => void>(() => {});

  const model = useCadStore((s) => s.model);
  const displayMode = useCadStore((s) => s.displayMode);
  const exploded = useCadStore((s) => s.exploded);
  const isolateChannels = useCadStore((s) => s.isolateChannels);
  const channelsOpaque = useCadStore((s) => s.channelsOpaque);

  const focusedTarget = useValidationStore((s) => s.focusedTarget);
  const graph = useProjectStore((s) => s.project.channelGraph);
  // Only a highlighted segment needs the loft, to trace its curve.
  const loft = useMemo(
    () => (focusedTarget?.edgeIds.length ? getLoft(graph, chipParams) : null),
    [focusedTarget, graph, chipParams],
  );

  // The tints come from CSS custom properties, which change with the colour
  // scheme. Tracking it re-runs the model effect so the chip re-tints rather
  // than keeping whichever palette happened to be live when it was built.
  const scheme = useColorScheme();

  // -------------------------------------------------------------------------
  // scene setup
  // -------------------------------------------------------------------------

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // No `preserveDrawingBuffer`: `snapshot` renders and reads the canvas back
    // in the same task, before the buffer is presented and cleared, so it does
    // not need the buffer kept — and keeping it costs a copy every frame on
    // some GPUs, tiled mobile ones especially.
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight, false);

    // Without tone mapping the light rig below clips: the key alone was already
    // past 1.0 across most of the chip face, so highlights flattened to pure
    // white and the form went with them.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap is deprecated as of three 0.185 and silently falls back
    // to this anyway; naming it directly keeps the console clean.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // The light and the chip are both fixed in world space — orbiting moves the
    // camera, not the shadow. Re-rendering the depth map every frame was the
    // single largest cost in the viewport; it is refreshed explicitly instead,
    // when the model or the chip footprint actually changes.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;

    host.append(renderer.domElement);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';

    const scene = new THREE.Scene();

    const perspCamera = new THREE.PerspectiveCamera(
      40,
      Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight),
      0.1,
      4000,
    );
    perspCamera.up.set(0, 0, 1); // chip space is +Z up, matching manifold-3d
    perspCamera.position.set(80, -90, 70);

    // The orthographic twin, engaged by an axis snap or the projection toggle.
    // Its frustum is a placeholder until then — `snapToAxis`/`applyProjection`
    // always size it from the model or the perspective camera before it is
    // ever rendered from.
    const orthoCamera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 4000);
    orthoCamera.up.set(0, 0, 1);
    orthoCamera.position.copy(perspCamera.position);

    const controls = new OrbitControls(perspCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;

    // An environment, so the material has something to reflect.
    //
    // `MeshStandardMaterial` is a PBR shader: with no environment its specular
    // term has nothing to sample and the chip renders as pure diffuse, which is
    // what made it look like matte cardboard. `RoomEnvironment` is generated in
    // code rather than loaded, so this stays offline — no HDR asset, no fetch.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = environment.texture;
    scene.environmentIntensity = 0.55;
    pmrem.dispose();

    // Direct light on top of that, at roughly half the old intensities — the
    // environment now carries the ambient term that the 1.1 AmbientLight was
    // faking, and doubling up on both is what blew the highlights out.
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(60, -80, 120);
    key.castShadow = true;
    // 1024 is ample for a chip that fills a shadow frustum sized to its own
    // footprint, and it halves the cost of every refresh.
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.35;
    scene.add(key);
    keyLightRef.current = key;

    const fill = new THREE.DirectionalLight(0xffffff, 0.45);
    fill.position.set(-70, 40, 50);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xaab4ff, 0.35);
    rim.position.set(0, 90, -40);
    scene.add(rim);

    const group = new THREE.Group();
    scene.add(group);

    // No post-processing chain, deliberately.
    //
    // An EffectComposer running GTAO for contact shading and SMAA for edges was
    // built and measured here. Against a plain render of the same scene it cost
    // 28 ms → 468 ms a frame, and side-by-side captures of a port socket were
    // near indistinguishable: the recess already reads from the cast shadow and
    // the creased normals, which is what GTAO was being asked to supply.
    //
    // Routing through a composer also gives up the renderer's own MSAA, so SMAA
    // was buying back an approximation of anti-aliasing the hardware had been
    // doing for free. Both passes went.
    sceneRef.current = scene;
    rendererRef.current = renderer;
    cameraRef.current = perspCamera;
    perspCameraRef.current = perspCamera;
    orthoCameraRef.current = orthoCamera;
    controlsRef.current = controls;
    modelGroupRef.current = group;

    let raf = 0;
    const frame = () => {
      raf = 0;
      const activeCamera = cameraRef.current;
      if (!activeCamera) return;
      // Damping eases the camera on after the pointer lets go; `update` says
      // whether it is still moving, and the frames keep coming until it stops.
      if (controls.update()) invalidate();
      renderer.render(scene, activeCamera);
    };
    const invalidate = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    invalidateRef.current = invalidate;
    controls.addEventListener('change', invalidate);
    invalidate();

    const observer = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      const aspect = w / h;
      const activeCamera = cameraRef.current;
      if (activeCamera instanceof THREE.OrthographicCamera) {
        // Resize by growing the frustum sideways, not vertically — that keeps
        // whatever the user had framed fully visible instead of clipping it.
        const halfHeight = (activeCamera.top - activeCamera.bottom) / 2;
        activeCamera.left = -halfHeight * aspect;
        activeCamera.right = halfHeight * aspect;
        activeCamera.updateProjectionMatrix();
      } else if (activeCamera) {
        activeCamera.aspect = aspect;
        activeCamera.updateProjectionMatrix();
      }
      invalidate();
    });
    observer.observe(host);

    // A rotate gesture — the primary mouse button, or a touch — should drop
    // an axis-aligned orthographic snap back to perspective, since the view is
    // no longer axis-aligned the moment it moves. A dolly (wheel) or the
    // right-button pan leave the projection alone. The first touch of a
    // two-finger pinch/pan is indistinguishable from a one-finger rotate at
    // pointerdown time, so it reverts too — an accepted imprecision here.
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      applyProjectionRef.current('perspective');
    };
    renderer.domElement.addEventListener('pointerdown', handlePointerDown);

    return () => {
      cancelAnimationFrame(raf);
      invalidateRef.current = () => {};
      controls.removeEventListener('change', invalidate);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      controls.dispose();
      environment.dispose();
      disposeChildren(group);
      renderer.dispose();
      // dispose() frees Three's buffers but leaves the context itself to the
      // garbage collector, and Chrome caps live contexts at 16: switching tabs
      // back and forth would otherwise evict the oldest, sometimes this one.
      renderer.forceContextLoss();
      renderer.domElement.remove();
      sceneRef.current = null;
      rendererRef.current = null;
      cameraRef.current = null;
      perspCameraRef.current = null;
      orthoCameraRef.current = null;
      controlsRef.current = null;
      modelGroupRef.current = null;
    };
  }, []);

  // -------------------------------------------------------------------------
  // ground plane + chip outline, rebuilt when the footprint changes
  // -------------------------------------------------------------------------

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const helpers = new THREE.Group();
    helpers.name = 'helpers';

    const span = Math.max(chipParams.width, chipParams.length) * 2;
    const centerX = chipParams.width / 2;
    const centerY = chipParams.length / 2;

    const line = token('--line-strong', '#33363e');
    const faint = token('--line', '#23252b');

    const grid = new THREE.GridHelper(span, 20, line, faint);
    // GridHelper lies in XZ; rotate it into the XY build plate.
    grid.rotation.x = Math.PI / 2;
    grid.position.set(centerX, centerY, 0);
    (grid.material as THREE.Material).opacity = 0.4;
    (grid.material as THREE.Material).transparent = true;
    // Behind the shadow catcher, so the grid does not draw over the contact
    // shadow the chip casts onto it.
    grid.renderOrder = -2;
    helpers.add(grid);

    // Shadow catcher.
    //
    // `ShadowMaterial` is transparent except where something shadows it, so the
    // build plate stays the panel background and only the contact darkening
    // under the chip is drawn. That one cue is most of what stopped the chip
    // reading as floating above the grid.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(span * 1.5, span * 1.5),
      new THREE.ShadowMaterial({ opacity: 0.3 }),
    );
    ground.position.set(centerX, centerY, 0);
    ground.receiveShadow = true;
    ground.renderOrder = -1;
    helpers.add(ground);
    groundRef.current = ground;

    // Aim the key light's shadow frustum at this chip. A directional light's
    // shadow camera is orthographic and fixed-size, so leaving it at the
    // default 5 mm box would shadow a corner of a 40 mm chip and nothing else.
    const key = keyLightRef.current;
    if (key) {
      key.target.position.set(centerX, centerY, 0);
      key.target.updateMatrixWorld();
      const half = span * 0.75;
      key.shadow.camera.left = -half;
      key.shadow.camera.right = half;
      key.shadow.camera.top = half;
      key.shadow.camera.bottom = -half;
      key.shadow.camera.near = 1;
      key.shadow.camera.far = span * 6;
      key.shadow.camera.updateProjectionMatrix();
      if (rendererRef.current) rendererRef.current.shadowMap.needsUpdate = true;
    }

    scene.add(helpers);
    invalidateRef.current();
    return () => {
      scene.remove(helpers);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      groundRef.current = null;
    };
  }, [chipParams.width, chipParams.length, scheme]);

  // -------------------------------------------------------------------------
  // model
  // -------------------------------------------------------------------------

  const frameAll = useCallback(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const group = modelGroupRef.current;
    const host = hostRef.current;
    if (!camera || !controls || !group || !host) return;

    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    if (camera instanceof THREE.OrthographicCamera) {
      // Fit re-centers whatever axis-aligned snap is already active rather
      // than jumping to the default isometric — it is a "the model drifted
      // out of frame" fix, not a mode change.
      const direction = camera.position.clone().sub(controls.target);
      const distance = Math.max(direction.length(), 20);
      direction.normalize();

      const radius = Math.max(size.length() / 2, 1) * 1.15;
      const aspect = Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight);
      const { halfWidth, halfHeight } = containInAspect(radius, radius, aspect);

      camera.left = -halfWidth;
      camera.right = halfWidth;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      camera.zoom = 1;
      camera.near = Math.max(0.01, distance / 500);
      camera.far = distance * 20;
      camera.position.copy(center).addScaledVector(direction, distance);
      camera.updateProjectionMatrix();
    } else {
      const radius = Math.max(size.x, size.y, size.z) * 0.75;
      const distance = radius / Math.tan((camera.fov * Math.PI) / 360);

      const direction = new THREE.Vector3(0.75, -1, 0.85).normalize();
      camera.position.copy(center).addScaledVector(direction, Math.max(distance, 20));
      camera.near = Math.max(0.05, distance / 500);
      camera.far = distance * 20;
      camera.updateProjectionMatrix();
    }

    controls.target.copy(center);
    controls.update();
    invalidateRef.current();
  }, []);

  /** Points the render loop and controls at `cam`, and mirrors the mode for the toolbar. */
  const activateCamera = useCallback(
    (cam: THREE.PerspectiveCamera | THREE.OrthographicCamera, mode: 'perspective' | 'orthographic') => {
      cameraRef.current = cam;
      if (controlsRef.current) controlsRef.current.object = cam;
      useCadStore.getState().setProjection(mode);
    },
    [],
  );

  /**
   * Swaps perspective/orthographic in place: same position, same look
   * direction, and — since a raw camera swap would otherwise snap to whatever
   * placeholder frustum or fov the idle camera last had — the same apparent
   * scale, derived from the current viewing distance.
   */
  const applyProjection = useCallback(
    (mode: 'perspective' | 'orthographic') => {
      const current = cameraRef.current;
      const controls = controlsRef.current;
      const host = hostRef.current;
      const persp = perspCameraRef.current;
      const ortho = orthoCameraRef.current;
      if (!current || !controls || !host || !persp || !ortho) return;

      const isOrtho = current instanceof THREE.OrthographicCamera;
      if ((mode === 'orthographic') === isOrtho) return;

      const aspect = Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight);
      const distance = Math.max(current.position.distanceTo(controls.target), 0.01);

      if (mode === 'orthographic') {
        const halfHeight = distance * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
        const halfWidth = halfHeight * aspect;
        ortho.left = -halfWidth;
        ortho.right = halfWidth;
        ortho.top = halfHeight;
        ortho.bottom = -halfHeight;
        ortho.zoom = 1;
        ortho.near = Math.max(0.01, distance / 500);
        ortho.far = distance * 20;
        ortho.position.copy(current.position);
        ortho.updateProjectionMatrix();
        activateCamera(ortho, 'orthographic');
      } else {
        const halfHeight = (ortho.top - ortho.bottom) / (2 * ortho.zoom);
        const fov = THREE.MathUtils.clamp(
          THREE.MathUtils.radToDeg(2 * Math.atan(halfHeight / distance)),
          5,
          100,
        );
        persp.fov = fov;
        persp.aspect = aspect;
        persp.near = Math.max(0.05, distance / 500);
        persp.far = distance * 20;
        persp.position.copy(current.position);
        persp.updateProjectionMatrix();
        activateCamera(persp, 'perspective');
      }

      controls.update();
      invalidateRef.current();
    },
    [activateCamera],
  );

  useEffect(() => {
    applyProjectionRef.current = applyProjection;
  }, [applyProjection]);

  const toggleProjection = useCallback(() => {
    const isOrtho = cameraRef.current instanceof THREE.OrthographicCamera;
    applyProjection(isOrtho ? 'perspective' : 'orthographic');
  }, [applyProjection]);

  const snapToAxis = useCallback(
    (axis: AxisView) => {
      const group = modelGroupRef.current;
      const controls = controlsRef.current;
      const ortho = orthoCameraRef.current;
      const host = hostRef.current;
      if (!group || !controls || !ortho || !host) return;

      const box = new THREE.Box3().setFromObject(group);
      if (box.isEmpty()) return;

      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const distance = Math.max(size.length(), 10) * 2;

      const aspect = Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight);
      const content = axisContentHalfExtents(size, axis);
      const margin = 1.15;
      const { halfWidth, halfHeight } = containInAspect(
        Math.max(content.halfWidth, 0.5) * margin,
        Math.max(content.halfHeight, 0.5) * margin,
        aspect,
      );

      ortho.left = -halfWidth;
      ortho.right = halfWidth;
      ortho.top = halfHeight;
      ortho.bottom = -halfHeight;
      ortho.zoom = 1;
      ortho.near = 0.01;
      ortho.far = distance * 4;
      ortho.position.copy(center).addScaledVector(AXIS_DIRECTIONS[axis], distance);
      ortho.updateProjectionMatrix();

      activateCamera(ortho, 'orthographic');
      controls.target.copy(center);
      controls.update();
      invalidateRef.current();
    },
    [activateCamera],
  );

  useEffect(() => {
    const group = modelGroupRef.current;
    if (!group) return;

    // Dispose the previous build before replacing it.
    disposeChildren(group);

    invalidateRef.current();
    if (!model) return;

    const colors = pieceColors();

    // Isolate mode replaces the chip rather than adding to it: the block is not
    // dimmed or ghosted, it is simply not built. Explode has nothing to act on
    // here either — the cavity is one solid, not two halves.
    //
    // Keyed off the mode, not off the cavity being there. With the toggle lit
    // and no channels drawn, an empty viewport is the honest answer; falling
    // back to the block would light a button that plainly did nothing.
    const isolating = displayMode === 'xray' && isolateChannels;
    const isolated = isolating ? model.channelSolid : null;

    if (isolating) {
      if (isolated) group.add(buildChannelMesh(isolated, channelsOpaque, colors));
    } else {
      for (const piece of model.pieces) {
        const mesh = buildMesh(piece, displayMode, colors);
        // The lid lifts along +Z so the two halves read as separable.
        mesh.position.z = exploded && piece.id === 'lid' ? chipParams.baseThickness * 1.6 : 0;
        group.add(mesh);
      }

      // The glass, on a slide chip. Drawn because the question it answers —
      // does the slide actually cover the channels — cannot be answered by
      // looking at an empty pocket. It is not a piece and never reaches an STL.
      if (model.slideSolid) {
        const glass = buildGlassMesh(model.slideSolid);
        // Explode lifts it clear, the way the lid lifts on a two-piece chip.
        glass.position.z = exploded ? chipParams.baseThickness * 1.6 : 0;
        group.add(glass);
      }
    }

    // New geometry casts a new shadow, and the depth map is not refreshed on
    // its own — see `shadowMap.autoUpdate` in the setup effect.
    if (rendererRef.current) rendererRef.current.shadowMap.needsUpdate = true;

    // Entering or leaving isolate mode changes what is on screen by an order of
    // magnitude — a 40 × 60 mm block against a 0.8 mm channel run — so the
    // framing that suited one leaves the other a speck in the corner. Re-frame
    // on the transition only: rebuilds and opacity flips must not yank a camera
    // the user has just positioned.
    const isolationChanged = wasIsolatingRef.current !== isolating;
    wasIsolatingRef.current = isolating;

    if (isolationChanged) {
      frameAll();
    } else if (!framedRef.current && model.pieces.length > 0) {
      framedRef.current = true;
      frameAll();
    }
    invalidateRef.current();
  }, [
    model,
    displayMode,
    exploded,
    isolateChannels,
    channelsOpaque,
    chipParams.baseThickness,
    frameAll,
    scheme,
  ]);

  // -------------------------------------------------------------------------
  // validation highlight
  //
  // The chip is one welded solid, so there is no sub-mesh to light up. Instead
  // the flagged elements get floating markers in chip space: a ring standing
  // above each node and a bright tube along each segment. Rendered on top of
  // everything (`depthTest` off) so a marker inside the block is still visible
  // — the point of clicking a warning is to find the thing, and a highlight
  // buried in resin would not do that.
  // -------------------------------------------------------------------------

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const group = new THREE.Group();
    group.name = 'validation-highlight';
    scene.add(group);
    highlightRef.current = group;

    return () => {
      disposeChildren(group);
      scene.remove(group);
      highlightRef.current = null;
    };
  }, []);

  useEffect(() => {
    const group = highlightRef.current;
    if (!group) return;

    disposeChildren(group);

    invalidateRef.current();
    if (!focusedTarget) return;

    const colour = 0xf5a524;
    const markerMaterial = new THREE.MeshBasicMaterial({
      color: colour,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });

    const nodeIds = new Set(focusedTarget.nodeIds);
    const edgeIds = new Set(focusedTarget.edgeIds);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    const topZ = chipParams.baseThickness;

    for (const node of graph.nodes) {
      if (!nodeIds.has(node.id)) continue;

      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.22, 10, 32), markerMaterial);
      ring.position.set(node.x, node.y, topZ + 2.2);
      ring.renderOrder = 999;
      group.add(ring);

      // A stalk down to the chip surface, so the ring reads as pointing at a
      // specific spot rather than floating arbitrarily.
      const stalk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.07, 2.2, 8),
        markerMaterial,
      );
      stalk.rotation.x = Math.PI / 2;
      stalk.position.set(node.x, node.y, topZ + 1.1);
      stalk.renderOrder = 999;
      group.add(stalk);
    }

    for (const edge of graph.edges) {
      if (!edgeIds.has(edge.id)) continue;
      const from = byId.get(edge.fromNodeId);
      const to = byId.get(edge.toNodeId);
      if (!from || !to) continue;

      const solved = loft?.edges.get(edge.id);
      const points = solved
        ? solved.samples.map((s) => new THREE.Vector3(s.point.x, s.point.y, topZ + 0.6))
        : [
            new THREE.Vector3(from.x, from.y, topZ + 0.6),
            new THREE.Vector3(to.x, to.y, topZ + 0.6),
          ];

      if (points.length < 2) continue;
      const curve = new THREE.CatmullRomCurve3(points);
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, Math.max(8, points.length), 0.35, 8, false),
        markerMaterial,
      );
      tube.renderOrder = 999;
      group.add(tube);
    }
    invalidateRef.current();
  }, [focusedTarget, graph, chipParams.baseThickness, loft]);

  // -------------------------------------------------------------------------

  useImperativeHandle(
    ref,
    (): CadViewportHandle => ({
      frameAll,
      snapToAxis,
      toggleProjection,
      snapshot: (scale: number) => {
        const renderer = rendererRef.current;
        const camera = cameraRef.current;
        const scene = sceneRef.current;
        const host = hostRef.current;
        if (!renderer || !camera || !scene || !host) return null;

        const width = host.clientWidth;
        const height = host.clientHeight;
        const previousRatio = renderer.getPixelRatio();

        // `scale` is a multiple of the on-screen CSS size, not of the current
        // device-pixel ratio. Multiplying by the DPR instead turned "3×" into
        // 6× on a retina display and produced a ~3 MB PNG — large enough to
        // blow the localStorage draft quota it gets saved into.
        const ratio = Math.max(1, Math.min(scale, MAX_SNAPSHOT_PX / Math.max(width, height)));

        // Raising the pixel ratio rather than resizing the canvas keeps the
        // framing and aspect identical to what is on screen, which is what
        // "snapshot of the current view" has to mean. Supersampling like this
        // is also the cheapest anti-aliasing there is for a still: the capture
        // is one frame, so it can afford what the live view cannot.
        renderer.setPixelRatio(ratio);
        renderer.setSize(width, height, false);
        renderer.render(scene, camera);
        const data = renderer.domElement.toDataURL('image/png');

        renderer.setPixelRatio(previousRatio);
        renderer.setSize(width, height, false);
        renderer.render(scene, camera);

        return data;
      },
    }),
    [frameAll, snapToAxis, toggleProjection],
  );

  return <div ref={hostRef} className="relative h-full w-full overflow-hidden bg-canvas" />;
}

// ---------------------------------------------------------------------------

/**
 * The fluid path, drawn as the only thing in the scene.
 *
 * Not a `buildMesh` mode: the chip's materials are all reading as *resin*, and
 * this is the void inside it. Opaque draws it as a part so its shape is legible;
 * transparent turns off depth writing so crossing runs and buried chambers show
 * through whatever is in front of them, which is the reason to want the mode at
 * all on a dense network.
 */
/**
 * The piece's creased render mesh as a geometry — see `creasedMesh.ts` for why
 * creased. The worker sends it ready-made with every preview build; creasing
 * here is only the fallback for a piece that arrived without one.
 */
function creasedGeometry(piece: CadPiecePayload): THREE.BufferGeometry {
  const render = piece.render ?? creasedRenderMesh(piece.positions, piece.indices);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(render.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(render.normals, 3));
  return geometry;
}

function buildChannelMesh(
  piece: CadPiecePayload,
  opaque: boolean,
  colors: Record<string, THREE.Color>,
): THREE.Mesh {
  const geometry = creasedGeometry(piece);

  const color = colors.channels ?? colors.solid;

  if (opaque) {
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0, envMapIntensity: 0.9 }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  return new THREE.Mesh(
    geometry,
    new THREE.MeshPhysicalMaterial({
      color,
      transparent: true,
      // Higher than the block's 0.18: with nothing else in the scene, the
      // channels have to carry the whole image on their own.
      opacity: 0.45,
      roughness: 0.25,
      transmission: 0.35,
      thickness: 1.5,
      envMapIntensity: 1.1,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
}

/**
 * The glass slide.
 *
 * Real glass, not a tinted box: transmission carries the image of the channels
 * through it, so you can see what the slide is covering rather than a frosted
 * slab sitting on top of them. `depthWrite: false` keeps it from occluding the
 * grooves underneath, which is the entire reason it is drawn at all.
 */
function buildGlassMesh(piece: CadPiecePayload): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(piece.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(piece.indices, 1));
  geometry.computeVertexNormals();

  return new THREE.Mesh(
    geometry,
    new THREE.MeshPhysicalMaterial({
      // The faint green of soda-lime glass seen edge-on.
      color: new THREE.Color('#dbeee9'),
      transparent: true,
      opacity: 0.3,
      roughness: 0.03,
      metalness: 0,
      transmission: 0.92,
      thickness: 1,
      ior: 1.52,
      envMapIntensity: 1.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
}

function buildMesh(
  piece: CadPiecePayload,
  mode: DisplayMode,
  colors: Record<string, THREE.Color>,
): THREE.Mesh {
  const geometry = creasedGeometry(piece);

  const color = colors[piece.id] ?? colors.solid;

  if (mode === 'wireframe') {
    return new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.55 }),
    );
  }

  if (mode === 'xray') {
    return new THREE.Mesh(
      geometry,
      new THREE.MeshPhysicalMaterial({
        color,
        transparent: true,
        // Toned down from 0.28: with an environment to reflect, the glass term
        // carries the form on its own and the old opacity buried the channels
        // this view exists to reveal.
        opacity: 0.18,
        roughness: 0.25,
        transmission: 0.55,
        thickness: 2,
        envMapIntensity: 1.1,
        // Both faces so interior channel walls are visible through the block —
        // which is the entire point of an x-ray view here.
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
  }

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color,
      // Cured resin is a dielectric with a slight sheen, not a faintly metallic
      // one. The old 0.04 metalness was doing nothing useful and tinted the
      // specular toward the base colour.
      roughness: 0.35,
      metalness: 0,
      envMapIntensity: 0.9,
      flatShading: false,
    }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

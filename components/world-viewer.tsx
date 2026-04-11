"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

type SparkModule = typeof import("@sparkjsdev/spark");
type CommonJsModule = { exports: Record<string, unknown> };

let sparkModulePromise: Promise<SparkModule> | null = null;

async function loadSparkModule() {
  if (!sparkModulePromise) {
    sparkModulePromise = fetch("/api/vendor/spark", { cache: "force-cache" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Failed to load the Spark viewer bundle.");
        }

        const source = await response.text();
        const module: CommonJsModule = { exports: {} };
        const commonJsRequire = (specifier: string) => {
          if (specifier === "three") {
            return THREE;
          }

          throw new Error(`Unsupported Spark dependency: ${specifier}`);
        };
        const evaluate = new Function(
          "exports",
          "module",
          "require",
          `${source}\nreturn module.exports;`
        ) as (
          exports: CommonJsModule["exports"],
          module: CommonJsModule,
          require: (specifier: string) => unknown
        ) => SparkModule;

        return evaluate(module.exports, module, commonJsRequire);
      })
      .catch((error) => {
        sparkModulePromise = null;
        throw error;
      });
  }

  return sparkModulePromise;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function clampToInterior(value: number, min: number, max: number, margin: number) {
  if (max - min <= margin * 2) {
    return (min + max) / 2;
  }

  return clamp(value, min + margin, max - margin);
}

function getEyeHeightWorldUnits(metricScaleFactor: number | null, worldHeight: number) {
  const estimated = metricScaleFactor && metricScaleFactor > 0 ? 1.6 * metricScaleFactor : worldHeight * 0.18;
  return clamp(estimated, 1.05, Math.max(1.35, worldHeight * 0.42));
}

export function WorldViewer({
  url,
  displayName,
  thumbnailUrl,
  groundPlaneOffset,
  metricScaleFactor,
  recenterSignal = 0
}: {
  url: string;
  displayName: string;
  thumbnailUrl: string | null;
  groundPlaneOffset: number | null;
  metricScaleFactor: number | null;
  recenterSignal?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resetViewRef = useRef<(() => void) | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (recenterSignal === 0) {
      return;
    }

    resetViewRef.current?.();
  }, [recenterSignal]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;
    let animationFrame = 0;
    let resizeObserver: ResizeObserver | null = null;
    let renderer: THREE.WebGLRenderer | null = null;
    let camera: THREE.PerspectiveCamera | null = null;
    let splatMesh:
      | (THREE.Object3D & {
          initialized: Promise<unknown>;
          getBoundingBox: () => THREE.Box3;
          dispose: () => void;
        })
      | null = null;

    setLoading(true);
    setErrorMessage(null);

    async function initialize() {
      try {
        const mount = containerRef.current;
        if (!mount) {
          return;
        }

        const sparkModule = await loadSparkModule();
        const { FpsMovement, PointerControls, SparkRenderer, SplatMesh } = sparkModule;

        renderer = new THREE.WebGLRenderer({
          antialias: false,
          alpha: true
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.setClearColor("#08090c", 1);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color("#08090c");

        camera = new THREE.PerspectiveCamera(78, 16 / 9, 0.03, 4000);
        // World Labs exports use an OpenCV-style world frame, so "up" is -Y here.
        camera.up.set(0, -1, 0);
        scene.add(camera);

        const sparkRenderer = new SparkRenderer({ renderer });
        camera.add(sparkRenderer);

        const fillLight = new THREE.HemisphereLight("#fff3d4", "#6d5a43", 1.2);
        scene.add(fillLight);

        const keyLight = new THREE.DirectionalLight("#ffffff", 0.65);
        keyLight.position.set(8, 16, 10);
        scene.add(keyLight);

        mount.innerHTML = "";
        mount.appendChild(renderer.domElement);

        const fpsMovement = new FpsMovement({
          moveSpeed: clamp(metricScaleFactor && metricScaleFactor > 0 ? 1.75 * metricScaleFactor : 1.75, 0.55, 3.6),
          shiftMultiplier: 3.2,
          ctrlMultiplier: 0.3
        });
        const pointerControls = new PointerControls({
          canvas: renderer.domElement,
          rotateSpeed: 0.0024,
          slideSpeed: 0.0046,
          scrollSpeed: 0.00125,
          doublePress: () => resetViewRef.current?.()
        });

        const resize = () => {
          if (!renderer || !camera || disposed) {
            return;
          }

          const width = Math.max(mount.clientWidth, 1);
          const height = Math.max(mount.clientHeight, 1);
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        };

        resize();
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(mount);

        const positionImmersiveCamera = (box: THREE.Box3) => {
          if (!camera) {
            return;
          }

          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());
          const worldHeight = Math.max(size.y, 2.25);
          const horizontalSpan = Math.max(size.x, size.z, 3);
          const horizontalMargin = Math.max(horizontalSpan * 0.08, 0.65);
          const floorY = groundPlaneOffset ?? box.max.y;
          const eyeHeight = getEyeHeightWorldUnits(metricScaleFactor, worldHeight);
          const spawnX = clampToInterior(0, box.min.x, box.max.x, horizontalMargin);
          const spawnZ = clampToInterior(0, box.min.z, box.max.z, horizontalMargin);
          const idealY = floorY - eyeHeight;
          const spawnY = clamp(
            idealY,
            box.min.y + Math.max(worldHeight * 0.14, 0.35),
            floorY - Math.max(eyeHeight * 0.18, 0.18)
          );
          const spawn = new THREE.Vector3(spawnX, spawnY, spawnZ);
          const forward = new THREE.Vector3(center.x - spawn.x, 0, center.z - spawn.z);

          if (forward.lengthSq() < 0.05) {
            if (size.z >= size.x) {
              forward.set(0, 0, center.z >= spawn.z ? 1 : -1);
            } else {
              forward.set(center.x >= spawn.x ? 1 : -1, 0, 0);
            }
          }

          forward.normalize();

          const targetDistance = clamp(horizontalSpan * 0.26, 2.4, 8);
          const target = spawn
            .clone()
            .addScaledVector(forward, targetDistance)
            .setY(spawnY - Math.min(worldHeight * 0.015, 0.08));

          camera.position.copy(spawn);
          camera.lookAt(target);
          camera.updateMatrixWorld();
        };

        resetViewRef.current = () => {
          if (!splatMesh) {
            return;
          }

          positionImmersiveCamera(splatMesh.getBoundingBox());
        };

        splatMesh = new SplatMesh({
          url,
          onLoad: () => {
            if (disposed) {
              return;
            }

            resetViewRef.current?.();
            setLoading(false);
          }
        });

        scene.add(splatMesh);
        await splatMesh.initialized;

        let lastFrameTime = performance.now();

        const render = () => {
          if (disposed || !renderer || !camera) {
            return;
          }

          const now = performance.now();
          const deltaTime = (now - lastFrameTime) / 1000;
          lastFrameTime = now;

          fpsMovement.update(deltaTime, camera);
          pointerControls.update(deltaTime, camera);
          renderer.render(scene, camera);
          animationFrame = window.requestAnimationFrame(render);
        };

        render();
      } catch (error) {
        if (!disposed) {
          setErrorMessage(error instanceof Error ? error.message : "Failed to load the 3D world.");
          setLoading(false);
        }
      }
    }

    void initialize();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      resetViewRef.current = null;
      splatMesh?.dispose();
      renderer?.dispose();
      if (renderer?.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [url, groundPlaneOffset, metricScaleFactor]);

  return (
    <div className="world-viewer-shell" aria-label={`${displayName} immersive 3D viewer`}>
      <div ref={containerRef} className="world-viewer-stage">
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={`${displayName} thumbnail`}
            className={`world-viewer-poster ${loading ? "visible" : ""}`}
          />
        ) : null}
      </div>

      {loading ? <div className="world-viewer-overlay">Loading world...</div> : null}
      {errorMessage ? <div className="world-viewer-overlay world-viewer-error">{errorMessage}</div> : null}
    </div>
  );
}

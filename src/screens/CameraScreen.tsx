import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Alert } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import type { StackScreenProps } from '@react-navigation/stack';
import Svg, { Polygon } from 'react-native-svg';
import {
  Camera,
  runAtTargetFps,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
  type Frame,
  type CameraDeviceFormat,
  type PhotoFile,
} from 'react-native-vision-camera';
import { Worklets } from 'react-native-worklets-core';
import { useResizePlugin } from 'vision-camera-resize-plugin';
import {
  OpenCV,
  ObjectType,
  DataTypes,
  RetrievalModes,
  ContourApproximationModes,
  MorphShapes,
  MorphTypes,
} from 'react-native-fast-opencv';

import type { RootStackParamList } from '../navigation/types';
import { useIsForeground } from '../hooks/useIsForeground';

type Props = StackScreenProps<RootStackParamList, 'Camera'>;

type Point = { x: number; y: number };

type Quad = readonly [Point, Point, Point, Point];

type DetectedQuad = {
  quad: Quad;
  frameWidth: number;
  frameHeight: number;
} | null;

type Size = { width: number; height: number };

type CameraConfig = {
  format: CameraDeviceFormat | undefined;
  fps: number | undefined;
};

type CropRect = { x: number; y: number; width: number; height: number };

const quadToCropRect = (quad: Quad): CropRect => {
  'worklet';
  const xs = [quad[0].x, quad[1].x, quad[2].x, quad[3].x];
  const ys = [quad[0].y, quad[1].y, quad[2].y, quad[3].y];
  const minX = Math.min(xs[0], xs[1], xs[2], xs[3]);
  const maxX = Math.max(xs[0], xs[1], xs[2], xs[3]);
  const minY = Math.min(ys[0], ys[1], ys[2], ys[3]);
  const maxY = Math.max(ys[0], ys[1], ys[2], ys[3]);

  return {
    x: Math.max(0, minX),
    y: Math.max(0, minY),
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
};

// Overlay backend: true = Skia, false = SVG
const USE_SKIA_OVERLAY = true;

// Precisa bater com o resizeMode do <Camera /> e com o modo do Preview para o overlay alinhar.
// true = 'contain' (sem crop/zoom, pode ter barras), false = 'cover' (preenche e corta/zoom)
const USE_CONTAIN_RESIZE_MODE = true;
const CAMERA_RESIZE_MODE: 'contain' | 'cover' = USE_CONTAIN_RESIZE_MODE ? 'contain' : 'cover';

const tryLoadSkia = (): null | {
  Canvas: any;
  Path: any;
  Skia: any;
} => {
  if (!USE_SKIA_OVERLAY) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@shopify/react-native-skia');
    return { Canvas: mod.Canvas, Path: mod.Path, Skia: mod.Skia };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('[Skia] not available (fallback to SVG):', String(e));
    return null;
  }
};

// FastOpenCV typings do not expose every OpenCV function name.
// Use a variadic invoke helper to avoid TS overload errors.
const ocvInvoke = OpenCV.invoke as unknown as (name: string, ...args: any[]) => any;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const smoothQuad = (prev: Quad, next: Quad, alpha: number): Quad =>
  [
    { x: lerp(prev[0].x, next[0].x, alpha), y: lerp(prev[0].y, next[0].y, alpha) },
    { x: lerp(prev[1].x, next[1].x, alpha), y: lerp(prev[1].y, next[1].y, alpha) },
    { x: lerp(prev[2].x, next[2].x, alpha), y: lerp(prev[2].y, next[2].y, alpha) },
    { x: lerp(prev[3].x, next[3].x, alpha), y: lerp(prev[3].y, next[3].y, alpha) },
  ] as const;

const toQuadFromRect = (
  rect: { x: number; y: number; width: number; height: number },
  ratioX: number,
  ratioY: number,
): Quad => {
  'worklet';
  const x1 = rect.x * ratioX;
  const y1 = rect.y * ratioY;
  const x2 = (rect.x + rect.width) * ratioX;
  const y2 = (rect.y + rect.height) * ratioY;

  return [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
  ] as const;
};

const normalizePointForPortrait = (
  p: Point,
  frameSize: Size,
  viewSize: Size,
): { point: Point; normalizedFrameSize: Size } => {
  'worklet';

  const isFrameLandscape = frameSize.width > frameSize.height;
  const isViewPortrait = viewSize.height > viewSize.width;

  if (isFrameLandscape && isViewPortrait) {
    // Rotação 90° CW
    const rotatedPoint: Point = {
      x: frameSize.height - p.y,
      y: p.x,
    };

    return {
      point: rotatedPoint,
      normalizedFrameSize: { width: frameSize.height, height: frameSize.width },
    };
  }

  return { point: p, normalizedFrameSize: frameSize };
};

type ResizeMode = 'cover' | 'contain';

const mapPointToView = (p: Point, frameSize: Size, viewSize: Size, resizeMode: ResizeMode): Point => {
  'worklet';

  const { point, normalizedFrameSize } = normalizePointForPortrait(p, frameSize, viewSize);

  const sx = viewSize.width / normalizedFrameSize.width;
  const sy = viewSize.height / normalizedFrameSize.height;

  // cover = preenche e corta (zoom), contain = mostra tudo (letterbox)
  const scale = resizeMode === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);

  const offsetX = (viewSize.width - normalizedFrameSize.width * scale) / 2;
  const offsetY = (viewSize.height - normalizedFrameSize.height * scale) / 2;

  return {
    x: point.x * scale + offsetX,
    y: point.y * scale + offsetY,
  };
};

export function CameraScreen({ navigation }: Props): React.ReactElement {
  const cameraRef = useRef<Camera>(null);

  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();

  const isFocused = useIsFocused();
  const isForeground = useIsForeground();
  const isActive = isFocused && isForeground;

  const lastGoodRef = useRef<DetectedQuad>(null);
  const lastGoodTsRef = useRef<number>(0);
  const stableDetectedRef = useRef<DetectedQuad>(null);

  const [isCapturing, setIsCapturing] = useState(false);
  const [lastPhoto, setLastPhoto] = useState<PhotoFile | null>(null);
  const [detected, setDetected] = useState<DetectedQuad>(null);
  const [previewSize, setPreviewSize] = useState<Size>({ width: 0, height: 0 });

  // UI toggles
  const [isRealtimeDetectionEnabled, setIsRealtimeDetectionEnabled] = useState(false);
  const [flash, setFlash] = useState<'off' | 'on'>('off');

  const isRealtimeEnabledRef = useRef<boolean>(false);

  const { resize } = useResizePlugin();

  const handleRequestPermission = useCallback(async (): Promise<void> => {
    try {
      await requestPermission();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('requestPermission error:', e);
    }
  }, [requestPermission]);

  const cameraConfig = useMemo((): CameraConfig => {
    if (!device) return { format: undefined, fps: undefined };

    const desiredFpsList = [30, 24, 15] as const;

    for (const desiredFps of desiredFpsList) {
      const formatsForFps: CameraDeviceFormat[] = device.formats
        .filter((f) => (f.maxFps ?? 0) >= desiredFps)
        .sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight);

      const best: CameraDeviceFormat | undefined = formatsForFps[0];
      if (best) {
        return { format: best, fps: desiredFps };
      }
    }

    return { format: device.formats[0], fps: undefined };
  }, [device]);

  const mappedQuad = useMemo(() => {
    if (!detected?.quad) return null;
    if (!previewSize.width || !previewSize.height) return null;

    const frameSize = { width: detected.frameWidth, height: detected.frameHeight };
    const viewSize = previewSize;

    return detected.quad.map((p) => mapPointToView(p, frameSize, viewSize, CAMERA_RESIZE_MODE));
  }, [detected, previewSize]);

  const quadPoints = useMemo(() => {
    if (!mappedQuad) return null;
    return mappedQuad.map((p) => `${p.x},${p.y}`).join(' ');
  }, [mappedQuad]);

  const skia = useMemo(() => tryLoadSkia(), []);

  const skiaPath = useMemo(() => {
    if (!skia?.Skia) return null;
    if (!mappedQuad) return null;

    const [p1, p2, p3, p4] = mappedQuad;
    const path = skia.Skia.Path.Make();
    path.moveTo(p1.x, p1.y);
    path.lineTo(p2.x, p2.y);
    path.lineTo(p3.x, p3.y);
    path.lineTo(p4.x, p4.y);
    path.close();
    return path;
  }, [mappedQuad, skia]);

  const onQuadDetected = useMemo(
    () =>
      Worklets.createRunOnJS((payload: DetectedQuad) => {
        if (!isRealtimeEnabledRef.current) return;
        const now = Date.now();
        const HOLD_MS = 250;
        const ALPHA = 0.35;

        setDetected((prev) => {
          if (!payload?.quad) {
            if (lastGoodRef.current && now - lastGoodTsRef.current < HOLD_MS) {
              return lastGoodRef.current;
            }
            lastGoodRef.current = null;
            return null;
          }

          const canSmooth =
            !!prev?.quad &&
            prev.frameWidth === payload.frameWidth &&
            prev.frameHeight === payload.frameHeight;

          const nextPayload: DetectedQuad = canSmooth
            ? {
                quad: smoothQuad(prev!.quad, payload.quad, ALPHA),
                frameWidth: payload.frameWidth,
                frameHeight: payload.frameHeight,
              }
            : payload;

          lastGoodRef.current = nextPayload;
          lastGoodTsRef.current = now;
          stableDetectedRef.current = nextPayload;
          return nextPayload;
        });
      }),
    [],
  );

  const logJS = useMemo(() => Worklets.createRunOnJS((msg: string) => console.log(msg)), []);

  const resetDetection = useCallback((): void => {
    lastGoodRef.current = null;
    lastGoodTsRef.current = 0;
    stableDetectedRef.current = null;
    setDetected(null);
  }, []);

  const setRealtimeEnabled = useCallback(
    (next: boolean): void => {
      isRealtimeEnabledRef.current = next;
      setIsRealtimeDetectionEnabled(next);
      if (!next) resetDetection();
    },
    [resetDetection],
  );

  const handleToggleRealtime = useCallback((): void => {
    setRealtimeEnabled(!isRealtimeEnabledRef.current);
  }, [setRealtimeEnabled]);

  const handleToggleFlash = useCallback((): void => {
    setFlash((prev) => (prev === 'off' ? 'on' : 'off'));
  }, []);

  const handleTakePhoto = useCallback(async (): Promise<void> => {
    if (!cameraRef.current) return;
    if (isCapturing) return;

    try {
      setIsCapturing(true);

      const stable = stableDetectedRef.current;

      // If realtime detection is enabled, enforce having a quad.
      if (isRealtimeDetectionEnabled && !stable?.quad) {
        Alert.alert('Detecção', 'Nenhum documento detectado. Posicione o documento dentro da câmera.');
        return;
      }

      const photo = await cameraRef.current.takePhoto({ flash });
      setLastPhoto(photo);

      const uri = photo.path.startsWith('file://') ? photo.path : `file://${photo.path}`;

      // eslint-disable-next-line no-console
      console.log('[CAPTURE] photo:', uri, 'quad:', stable?.quad ?? null);
      // Debug: validate route params
      console.log('[NAVIGATE] Preview baseParams:', { uri });

      // Base params (always)
      const baseParams = { uri } as RootStackParamList['Preview'];

      // If we have a detected quad, also pass extra info for cropping/editing.
      if (stable?.quad) {
        const cropRectFrame = quadToCropRect(stable.quad);

        // Map frame-space crop to photo-space crop by scaling.
        // NOTE: PhotoFile has width/height (px) so we can scale proportionally.
        const sx = photo.width / stable.frameWidth;
        const sy = photo.height / stable.frameHeight;

        const cropRectPhoto = {
          x: cropRectFrame.x * sx,
          y: cropRectFrame.y * sy,
          width: cropRectFrame.width * sx,
          height: cropRectFrame.height * sy,
        };

        const previewParams = {
          ...(baseParams as any),
          originalUri: uri,
          quad: stable.quad,
          frameSize: { width: stable.frameWidth, height: stable.frameHeight },
          photoSize: { width: photo.width, height: photo.height },
          cropRect: cropRectPhoto,
        };

        console.log('[NAVIGATE] Preview params (with quad):', {
          uri: previewParams.uri,
          originalUri: previewParams.originalUri,
          frameSize: previewParams.frameSize,
          photoSize: previewParams.photoSize,
          cropRect: previewParams.cropRect,
          quad: previewParams.quad,
        });

        navigation.navigate('Preview', previewParams as any);

        return;
      }

      console.log('[NAVIGATE] Preview params (no quad):', baseParams);
      navigation.navigate('Preview', baseParams);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('takePhoto error:', e);
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('Erro ao capturar', msg);
    } finally {
      setIsCapturing(false);
    }
  }, [flash, isCapturing, isRealtimeDetectionEnabled, navigation]);

  const frameProcessor = useFrameProcessor(
    (frame: Frame) => {
      'worklet';

      runAtTargetFps(8, () => {
        'worklet';

        // @ts-expect-error
        globalThis.__fpCount = (globalThis.__fpCount ?? 0) + 1;
        // @ts-expect-error
        const c = globalThis.__fpCount as number;

        const logEvery = 16;
        const wlog = (msg: string) => {
          if (c % logEvery === 0) logJS(msg);
        };

        let stage = 'S0';

        try {
          stage = 'S1: calc size';
          const scale = 0.25;
          const width = Math.max(1, Math.round(frame.width * scale));
          const height = Math.max(1, Math.round(frame.height * scale));
          wlog(`FP ok ${stage} w=${width} h=${height}`);

          stage = 'S2: resize';
          const resized = resize(frame, {
            scale: { width, height },
            pixelFormat: 'bgr',
            dataType: 'uint8',
          }) as unknown as Uint8Array;

          const expected = width * height * 3;
          if (!resized || resized.byteLength < expected) {
            wlog(`FP stop ${stage} buffer inválido len=${resized?.byteLength ?? -1} exp=${expected}`);
            return;
          }
          wlog(`FP ok ${stage} len=${resized.byteLength}`);

          stage = 'S3: bufferToMat';
          const src = OpenCV.bufferToMat('uint8', height, width, 3, resized);

          stage = 'S4: mats';
          const gray = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          const blurred = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          const edges = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);

          stage = 'S5: cvtColor';
          OpenCV.invoke('cvtColor', src, gray, 6);

          stage = 'S5.1: equalizeHist';
          ocvInvoke('equalizeHist', gray, gray);

          stage = 'S5.2: morphology';
          const morphK = OpenCV.createObject(ObjectType.Size, 3, 3);
          const morphElem = ocvInvoke('getStructuringElement', MorphShapes.MORPH_ELLIPSE, morphK);
          OpenCV.invoke('morphologyEx', gray, gray, MorphTypes.MORPH_OPEN, morphElem);
          OpenCV.invoke('morphologyEx', gray, gray, MorphTypes.MORPH_CLOSE, morphElem);

          stage = 'S6: GaussianBlur';
          const ksize = OpenCV.createObject(ObjectType.Size, 5, 5);
          OpenCV.invoke('GaussianBlur', gray, blurred, ksize, 0);

          stage = 'S7: Canny';
          OpenCV.invoke('Canny', blurred, edges, 60, 140);
          wlog(`FP ok ${stage}`);

          stage = 'S8: findContours';
          const contours = OpenCV.createObject(ObjectType.MatVector);

          const mode = RetrievalModes.RETR_LIST;
          const method = ContourApproximationModes.CHAIN_APPROX_SIMPLE;
          wlog(`FP findContours args mode=${String(mode)} method=${String(method)}`);

          ocvInvoke('findContours', edges, contours, mode, method);

          const contoursJS = OpenCV.toJSValue(contours) as { array: unknown[] };
          wlog(`FP ok ${stage} contours=${contoursJS.array.length}`);

          stage = 'S9: pick best';
          let bestScore = 0;
          let bestQuad: Quad | null = null;

          const ratioX = frame.width / width;
          const ratioY = frame.height / height;

          const minRectArea = width * height * 0.08;
          const minAspect = 1.2;
          const maxAspect = 2.3;

          for (let i = 0; i < contoursJS.array.length; i++) {
            const contour = OpenCV.copyObjectFromVector(contours, i);

            const rectObj = OpenCV.invoke('boundingRect', contour);
            const rect = OpenCV.toJSValue(rectObj) as { x: number; y: number; width: number; height: number };

            const rectArea = rect.width * rect.height;
            if (rectArea < minRectArea) continue;

            const aspect = rect.width >= rect.height ? rect.width / rect.height : rect.height / rect.width;
            if (aspect < minAspect || aspect > maxAspect) continue;

            const { value: contourArea } = ocvInvoke('contourArea', contour, false) as { value: number };
            const score = contourArea * 0.7 + rectArea * 0.3;

            if (score > bestScore) {
              bestScore = score;
              bestQuad = toQuadFromRect(rect, ratioX, ratioY);
            }
          }

          wlog(`FP ok ${stage} bestScore=${Math.round(bestScore)}`);

          onQuadDetected(bestQuad ? { quad: bestQuad, frameWidth: frame.width, frameHeight: frame.height } : null);
        } catch (e) {
          logJS(`FP ERRO ${stage}: ${String(e)}`);
        } finally {
          OpenCV.clearBuffers();
        }
      });
    },
    [resize, onQuadDetected, logJS],
  );

  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>Precisamos da permissão da câmera.</Text>
        <Pressable style={styles.btn} onPress={handleRequestPermission}>
          <Text style={styles.btnText}>Permitir câmera</Text>
        </Pressable>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>Carregando câmera…</Text>
      </View>
    );
  }

  return (
    <View
      style={styles.container}
      onLayout={(e) => {
        const { width: w, height: h } = e.nativeEvent.layout;
        setPreviewSize({ width: w, height: h });
      }}
    >
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={isActive}
        photo
        format={cameraConfig.format}
        fps={cameraConfig.fps}
        frameProcessor={isRealtimeDetectionEnabled ? frameProcessor : undefined}
        resizeMode={CAMERA_RESIZE_MODE}
      />

      <View style={styles.topBar} pointerEvents="box-none">
        <Pressable style={styles.topBtn} onPress={handleToggleFlash}>
          <Text style={styles.topBtnText}>{flash === 'on' ? 'Flash: ON' : 'Flash: OFF'}</Text>
        </Pressable>

        <Pressable style={[styles.topBtn, styles.topBtnDisabled]} disabled>
          <Text style={styles.topBtnText}>OCR</Text>
        </Pressable>

        <Pressable
          style={[styles.topBtn, isRealtimeDetectionEnabled && styles.topBtnActive]}
          onPress={handleToggleRealtime}
        >
          <Text style={styles.topBtnText}>{isRealtimeDetectionEnabled ? 'Detectando' : 'Detecção'}</Text>
        </Pressable>
      </View>

      {/* Overlay do contorno (SVG ou Skia) */}
      {isRealtimeDetectionEnabled && !USE_SKIA_OVERLAY && quadPoints ? (
        <Svg pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Polygon points={quadPoints} fill="rgba(0,0,0,0.0)" stroke="lime" strokeWidth={3} />
        </Svg>
      ) : null}

      {isRealtimeDetectionEnabled && USE_SKIA_OVERLAY && skia?.Canvas && skia?.Path && skiaPath ? (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <skia.Canvas style={StyleSheet.absoluteFill}>
            <skia.Path path={skiaPath} style="stroke" strokeWidth={3} color="lime" />
          </skia.Canvas>
        </View>
      ) : null}

      <View style={styles.bottomBar}>
        <Pressable
          style={[
            styles.btn,
            ((isRealtimeDetectionEnabled && !detected?.quad) || isCapturing) && styles.btnDisabled,
          ]}
          onPress={handleTakePhoto}
          disabled={(isRealtimeDetectionEnabled && !detected?.quad) || isCapturing}
        >
          <Text style={styles.btnText}>{isCapturing ? 'Capturando…' : 'Capturar'}</Text>
        </Pressable>

        {isRealtimeDetectionEnabled ? (
          <Text style={styles.hint}>{detected?.quad ? 'Documento detectado ✅' : 'Procurando documento…'}</Text>
        ) : lastPhoto?.path ? (
          <Text style={styles.hint} numberOfLines={1}>
            Última foto: {lastPhoto.path}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 16 },
  text: { color: '#111' },
  topBar: {
    position: 'absolute',
    top: 18,
    left: 12,
    right: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  topBtn: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#111',
  },
  topBtnActive: {
    backgroundColor: '#1a3d1a',
  },
  topBtnDisabled: {
    opacity: 0.6,
  },
  topBtnText: {
    color: '#fff',
    fontWeight: '700',
  },
  bottomBar: { position: 'absolute', left: 0, right: 0, bottom: 24, alignItems: 'center', gap: 10 },
  btn: { paddingVertical: 12, paddingHorizontal: 18, borderRadius: 12, backgroundColor: '#111' },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontWeight: '700' },
  hint: { color: '#fff', fontWeight: '700', paddingHorizontal: 16 },
});
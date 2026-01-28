import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cropDocumentFromFile } from '../utils/functions/opencv/cropDocument';
import {
  Image,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  Modal,
  type LayoutChangeEvent,
} from 'react-native';
import { Svg, Polygon, Polyline } from 'react-native-svg';
import type { StackScreenProps } from '@react-navigation/stack';
import type { RootStackParamList } from '../navigation/types';

type Props = StackScreenProps<RootStackParamList, 'Preview'>;

type Point = { x: number; y: number };

type QuadPoints = [Point, Point, Point, Point];

type CropResult = { uri: string; width?: number; height?: number };

type ImageMeta = { width: number; height: number };

type Size = { width: number; height: number };

type PreviewParams = {
  uri?: string;
  originalUri?: string;
  croppedUri?: string;
  quad?: unknown;
  quadPhoto?: unknown;
  frameSize?: Size;
  photoSize?: Size;
};


type DisplayRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
};

// ---- Helpers for RAW->DISPLAY mapping ----

type SwappedRotation = 'cw' | 'ccw';

// ✅ Ajuste principal: em iOS, quando o JPEG vem com EXIF/orientation (portrait),
// o `Image.getSize()` costuma devolver a dimensão já orientada (portrait), enquanto o arquivo é RAW (landscape).
// Nos testes deste projeto, o mapeamento correto para RAW->DISPLAY é 90° *CCW*.
// Se em algum device ficar invertido, basta trocar para 'cw'.
const SWAPPED_ROTATION: SwappedRotation = 'ccw';

const rotatePointForSwappedSize = (p: Point, raw: ImageMeta, mode: SwappedRotation): Point => {
  if (mode === 'cw') {
    // 90° clockwise: (x,y) -> (y, rawW - x)
    return { x: p.y, y: raw.width - p.x };
  }

  // 90° counter-clockwise: (x,y) -> (rawH - y, x)
  return { x: raw.height - p.y, y: p.x };
};
const almostEqual = (a: number, b: number, tolerance = 2): boolean => Math.abs(a - b) <= tolerance;

const isSwappedSize = (a: ImageMeta, b: ImageMeta): boolean => {
  // Ex: raw 4032x3024 vs display 3024x4032
  return almostEqual(a.width, b.height) && almostEqual(a.height, b.width);
};

// Converte pontos do espaço RAW (pixels do arquivo) para o espaço DISPLAY (como o <Image/> renderiza após EXIF/orientation)
// iOS normalmente salva JPEG com EXIF orientation em portrait -> raw landscape (w>h) e display portrait (h>w).
const mapPointRawToDisplay = (p: Point, raw: ImageMeta, display: ImageMeta): Point => {
  if (almostEqual(raw.width, display.width) && almostEqual(raw.height, display.height)) {
    return p;
  }

  if (isSwappedSize(raw, display)) {
    return rotatePointForSwappedSize(p, raw, SWAPPED_ROTATION);
  }

  // Fallback: apenas escala (quando dimensões mudam sem rotação)
  const sx = display.width / raw.width;
  const sy = display.height / raw.height;
  return { x: p.x * sx, y: p.y * sy };
};

const mapQuadRawToDisplay = (quad: QuadPoints, raw: ImageMeta, display: ImageMeta): QuadPoints => {
  return [
    mapPointRawToDisplay(quad[0], raw, display),
    mapPointRawToDisplay(quad[1], raw, display),
    mapPointRawToDisplay(quad[2], raw, display),
    mapPointRawToDisplay(quad[3], raw, display),
  ];
};
// Inverso do mapeamento: DISPLAY -> RAW (para recortar usando coordenadas do arquivo)
const rotatePointDisplayToRawForSwappedSize = (p: Point, raw: ImageMeta, mode: SwappedRotation): Point => {
  if (mode === 'cw') {
    // raw -> display (cw): (x,y) -> (y, rawW - x)
    // inverso: (x',y') -> (rawW - y', x')
    return { x: raw.width - p.y, y: p.x };
  }

  // raw -> display (ccw): (x,y) -> (rawH - y, x)
  // inverso: (x',y') -> (y', rawH - x')
  return { x: p.y, y: raw.height - p.x };
};

const mapPointDisplayToRaw = (p: Point, raw: ImageMeta, display: ImageMeta): Point => {
  if (almostEqual(raw.width, display.width) && almostEqual(raw.height, display.height)) {
    return p;
  }

  if (isSwappedSize(raw, display)) {
    return rotatePointDisplayToRawForSwappedSize(p, raw, SWAPPED_ROTATION);
  }

  // Fallback: escala inversa
  const sx = raw.width / display.width;
  const sy = raw.height / display.height;
  return { x: p.x * sx, y: p.y * sy };
};

const mapQuadDisplayToRaw = (quad: QuadPoints, raw: ImageMeta, display: ImageMeta): QuadPoints => {
  return [
    mapPointDisplayToRaw(quad[0], raw, display),
    mapPointDisplayToRaw(quad[1], raw, display),
    mapPointDisplayToRaw(quad[2], raw, display),
    mapPointDisplayToRaw(quad[3], raw, display),
  ];
};

const flipQuadYInDisplay = (quad: QuadPoints, display: ImageMeta): QuadPoints => {
  return [
    { x: quad[0].x, y: display.height - quad[0].y },
    { x: quad[1].x, y: display.height - quad[1].y },
    { x: quad[2].x, y: display.height - quad[2].y },
    { x: quad[3].x, y: display.height - quad[3].y },
  ];
};

const needsVerticalFlip = (quad: QuadPoints): boolean => {
  // Em coordenadas de imagem/tela (origem no topo-esquerda), TL.y deve ser menor que BL.y.
  // Se TL.y > BL.y, é forte sinal de eixo Y invertido.
  return quad[0].y > quad[3].y;
};

// Normaliza a ordem dos cantos: TL, TR, BR, BL

const orderQuadTLTRBRBL = (quad: QuadPoints): QuadPoints => {
  // Heurística clássica: funciona bem para documentos (retângulos) mesmo com perspectiva.
  // tl = menor (x+y), br = maior (x+y), tr = maior (x-y), bl = menor (x-y)
  const [p0, p1, p2, p3] = quad;
  const pts = [p0, p1, p2, p3];

  const sum = (p: Point) => p.x + p.y;
  const diff = (p: Point) => p.x - p.y;

  const tl = pts.reduce((a, b) => (sum(b) < sum(a) ? b : a));
  const br = pts.reduce((a, b) => (sum(b) > sum(a) ? b : a));
  const tr = pts.reduce((a, b) => (diff(b) > diff(a) ? b : a));
  const bl = pts.reduce((a, b) => (diff(b) < diff(a) ? b : a));

  return [tl, tr, br, bl];
};
const scaleQuad = (quad: QuadPoints, from: ImageMeta, to: ImageMeta): QuadPoints => {
  const sx = to.width / from.width;
  const sy = to.height / from.height;

  return [
    { x: quad[0].x * sx, y: quad[0].y * sy },
    { x: quad[1].x * sx, y: quad[1].y * sy },
    { x: quad[2].x * sx, y: quad[2].y * sy },
    { x: quad[3].x * sx, y: quad[3].y * sy },
  ];
};

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

const ensureFileUri = (raw?: string): string | undefined => {
  if (!raw) return undefined;
  return raw.startsWith('file://') ? raw : `file://${raw}`;
};

const normalizeQuad = (quad: unknown): QuadPoints | undefined => {
  if (!Array.isArray(quad) || quad.length !== 4) return undefined;

  const points: Point[] = [];
  for (const p of quad) {
    if (!p || typeof p !== 'object') return undefined;
    const x = (p as any).x;
    const y = (p as any).y;
    if (typeof x !== 'number' || typeof y !== 'number') return undefined;
    points.push({ x, y });
  }

  return orderQuadTLTRBRBL([points[0], points[1], points[2], points[3]]);
};

const buildFallbackQuadOnImage = (img: ImageMeta): QuadPoints => {
  // inset de 8% nas bordas, pra já começar “parecendo” um documento
  const insetX = img.width * 0.08;
  const insetY = img.height * 0.08;

  return [
    { x: insetX, y: insetY },
    { x: img.width - insetX, y: insetY },
    { x: img.width - insetX, y: img.height - insetY },
    { x: insetX, y: img.height - insetY },
  ];
};

const computeDisplayRect = (containerW: number, containerH: number, img: ImageMeta): DisplayRect => {
  const scale = Math.min(containerW / img.width, containerH / img.height);
  const width = img.width * scale;
  const height = img.height * scale;
  const x = (containerW - width) / 2;
  const y = (containerH - height) / 2;

  return { x, y, width, height, scale };
};

const imageToView = (p: Point, rect: DisplayRect): Point => ({
  x: rect.x + p.x * rect.scale,
  y: rect.y + p.y * rect.scale,
});

const viewToImage = (p: Point, rect: DisplayRect): Point => ({
  x: (p.x - rect.x) / rect.scale,
  y: (p.y - rect.y) / rect.scale,
});

const clampToDisplay = (p: Point, rect: DisplayRect): Point => ({
  x: clamp(p.x, rect.x, rect.x + rect.width),
  y: clamp(p.y, rect.y, rect.y + rect.height),
});

const quadImageToView = (quad: QuadPoints, rect: DisplayRect): QuadPoints => [
  imageToView(quad[0], rect),
  imageToView(quad[1], rect),
  imageToView(quad[2], rect),
  imageToView(quad[3], rect),
];

const quadViewToImage = (quad: QuadPoints, rect: DisplayRect): QuadPoints => [
  viewToImage(quad[0], rect),
  viewToImage(quad[1], rect),
  viewToImage(quad[2], rect),
  viewToImage(quad[3], rect),
];

export function PreviewScreen({ route }: Props): React.ReactElement {
  const params = (route.params ?? {}) as unknown as PreviewParams;

  const originalUri = ensureFileUri(params.originalUri ?? params.uri);
  const initialCroppedUri = ensureFileUri(params.croppedUri) ?? originalUri;

  const [croppedUri, setCroppedUri] = useState<string | undefined>(initialCroppedUri);
  const [isCropping, setIsCropping] = useState(false);
  const [cropError, setCropError] = useState<string | null>(null);

  const rawPhotoMeta = useMemo<ImageMeta | null>(() => {
    const ps = (params as any)?.photoSize;
    const pw = ps?.width;
    const ph = ps?.height;
    if (typeof pw === 'number' && typeof ph === 'number' && Number.isFinite(pw) && Number.isFinite(ph) && pw > 0 && ph > 0) {
      return { width: pw, height: ph };
    }
    return null;
  }, [params]);

  const [imageMeta, setImageMeta] = useState<ImageMeta | null>(null);

  const incomingQuadOnImage = useMemo<QuadPoints | undefined>(() => {
    const rawNormalized = normalizeQuad(params.quadPhoto ?? params.quad);
    if (!rawNormalized) return undefined;

    const frame = (params.frameSize && typeof params.frameSize.width === 'number' && typeof params.frameSize.height === 'number')
      ? { width: params.frameSize.width, height: params.frameSize.height }
      : null;

    // RAW meta (pixels do arquivo) vindo do takePhoto
    const photoRaw = (rawPhotoMeta && rawPhotoMeta.width > 0 && rawPhotoMeta.height > 0) ? rawPhotoMeta : null;

    // DISPLAY meta (como o <Image/> renderiza)
    const display = (imageMeta && imageMeta.width > 0 && imageMeta.height > 0) ? imageMeta : null;

    // 1) Quad no espaço RAW
    let quadRaw: QuadPoints;

    if (params.quadPhoto) {
      quadRaw = orderQuadTLTRBRBL(rawNormalized);
    } else if (frame && photoRaw) {
      quadRaw = orderQuadTLTRBRBL(scaleQuad(rawNormalized, frame, photoRaw));
    } else {
      // Fallback: assume que veio no espaço DISPLAY/RAW - vamos ajustar abaixo se necessário
      quadRaw = orderQuadTLTRBRBL(rawNormalized);
    }

    // 2) RAW -> DISPLAY (corrige o caso clássico de EXIF/orientation no iOS)
    if (photoRaw && display) {
      console.log('[PREVIEW] map RAW->DISPLAY', {
        swappedRotation: SWAPPED_ROTATION,
        photoRaw,
        display,
        quadRaw,
      });
      let mapped = orderQuadTLTRBRBL(mapQuadRawToDisplay(quadRaw, photoRaw, display));

      // Ajuste extra: em alguns devices/iOS, depois de aplicar a rotação RAW->DISPLAY,
      // o eixo Y pode ficar invertido (topo vira baixo). Detecta e corrige.
      if (needsVerticalFlip(mapped)) {
        mapped = orderQuadTLTRBRBL(flipQuadYInDisplay(mapped, display));
      }

      console.log('[PREVIEW] quad after map (display space)', mapped);
      return mapped;
    }

    return quadRaw;
  }, [imageMeta, params, rawPhotoMeta]);

  const [previewSize, setPreviewSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [editorSize, setEditorSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Removed unused quadView state
  const [isEditing, setIsEditing] = useState(false);
  const [editQuadView, setEditQuadView] = useState<QuadPoints | null>(null);
  const [quadOnImage, setQuadOnImage] = useState<QuadPoints | null>(incomingQuadOnImage ?? null);

  const onPreviewLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setPreviewSize({ w: width, h: height });
  }, []);

  const onEditorLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setEditorSize({ w: width, h: height });
  }, []);

  useEffect(() => {
    if (!originalUri) return;

    let isActive = true;

    Image.getSize(
      originalUri,
      (width, height) => {
        if (!isActive) return;
        // ✅ meta no mesmo espaço que o <Image/> renderiza (respeita EXIF/orientation)
        setImageMeta({ width, height });
      },
      () => {
        if (!isActive) return;
        // Fallback: usa o tamanho bruto vindo do takePhoto (RAW)
        setImageMeta(rawPhotoMeta);
      },
    );

    return () => {
      isActive = false;
    };
  }, [rawPhotoMeta, originalUri]);

  useEffect(() => {
    setCroppedUri(initialCroppedUri);
  }, [initialCroppedUri]);

  const previewDisplayRect = useMemo<DisplayRect | null>(() => {
    if (!imageMeta) return null;
    if (previewSize.w <= 0 || previewSize.h <= 0) return null;

    return computeDisplayRect(previewSize.w, previewSize.h, imageMeta);
  }, [imageMeta, previewSize.h, previewSize.w]);

  const previewQuadView = useMemo<QuadPoints | null>(() => {
    if (!quadOnImage || !previewDisplayRect) return null;

    // Só desenha overlay quando a imagem exibida é a ORIGINAL.
    // Depois de recortar, mostramos apenas a recortada (sem overlay).
    const showingOriginal = !croppedUri || croppedUri === originalUri;
    if (!showingOriginal) return null;

    return quadImageToView(quadOnImage, previewDisplayRect);
  }, [croppedUri, originalUri, previewDisplayRect, quadOnImage]);

  const editorDisplayRect = useMemo<DisplayRect | null>(() => {
    if (!imageMeta) return null;
    if (editorSize.w <= 0 || editorSize.h <= 0) return null;

    return computeDisplayRect(editorSize.w, editorSize.h, imageMeta);
  }, [editorSize.h, editorSize.w, imageMeta]);

  useEffect(() => {
    if (!imageMeta || !previewDisplayRect) return;

    const baseQuadOnImage = incomingQuadOnImage
      ? orderQuadTLTRBRBL(incomingQuadOnImage)
      : orderQuadTLTRBRBL(buildFallbackQuadOnImage(imageMeta));

    // Mantém um espelho em coordenadas da imagem para o passo de recorte
    setQuadOnImage(baseQuadOnImage);
  }, [previewDisplayRect, imageMeta, incomingQuadOnImage]);

  const openEditor = useCallback(() => {
    if (!quadOnImage || !previewDisplayRect) return;

    const next = quadImageToView(quadOnImage, previewDisplayRect);
    setEditQuadView(next);
    setIsEditing(true);
  }, [previewDisplayRect, quadOnImage]);

  useEffect(() => {
    if (!isEditing) return;
    if (!quadOnImage || !editorDisplayRect) return;

    setEditQuadView(quadImageToView(quadOnImage, editorDisplayRect));
  }, [editorDisplayRect, isEditing, quadOnImage]);

  const updateEditPoint = useCallback((index: 0 | 1 | 2 | 3, next: Point) => {
    setEditQuadView(prev => {
      if (!prev || !editorDisplayRect) return prev;

      const clamped = clampToDisplay(next, editorDisplayRect);
      const out: QuadPoints = [
        { ...prev[0] },
        { ...prev[1] },
        { ...prev[2] },
        { ...prev[3] },
      ];

      out[index] = clamped;
      return out;
    });
  }, [editorDisplayRect]);


  const handleConfirm = useCallback(async () => {
    if (!originalUri) return;
    if (!quadOnImage) return;
    if (isCropping) return;

    try {
      setIsCropping(true);
      setCropError(null);
      let quadForCrop: QuadPoints = quadOnImage;

      let outputRotate: 'none' | 'cw' | 'ccw' | '180' = 'none';
      if (rawPhotoMeta && imageMeta) {
        const mapped = mapQuadDisplayToRaw(quadOnImage, rawPhotoMeta, imageMeta);

        const clamped = mapped.map(p => ({
          x: clamp(p.x, 0, rawPhotoMeta.width),
          y: clamp(p.y, 0, rawPhotoMeta.height),
        })) as QuadPoints;

        quadForCrop = orderQuadTLTRBRBL(clamped);

        // Rotação do arquivo final:
        // - O OpenCV trabalha em RAW pixels.
        // - O <Image/> no iOS costuma respeitar EXIF/orientation e "girar" a visualização.
        // Quando detectamos tamanho "swapped" (raw WxH vs display HxW), aplicamos rotação no output
        // para o arquivo recortado ficar na mesma orientação que o preview.
        // Se em algum device ficar invertido, basta trocar `AUTO_CROP_ROTATION`.
        const AUTO_CROP_ROTATION: 'cw' | 'ccw' = SWAPPED_ROTATION; // ajuste aqui se necessário
        const shouldRotateOutput = Boolean(rawPhotoMeta && imageMeta && isSwappedSize(rawPhotoMeta, imageMeta));
        outputRotate = shouldRotateOutput ? AUTO_CROP_ROTATION : 'none';

        console.log('[PREVIEW] crop input DISPLAY->RAW', {
          swappedRotation: SWAPPED_ROTATION,
          rawMeta: rawPhotoMeta,
          displayMeta: imageMeta,
          quadDisplay: quadOnImage,
          quadRaw: quadForCrop,
          outputRotate,
        });
      } else {
        console.log('[PREVIEW] crop input (no meta, using quad as-is)', {
          quadDisplay: quadOnImage,
          rawPhotoMeta,
          imageMeta,
        });
      }

      // cropDocument deve receber a imagem ORIGINAL (file://...) e o quad no espaço RAW da foto (pixels)
      const result = await cropDocumentFromFile({
        fileUri: originalUri,
        quad: quadForCrop,
        debug: false,
        output: { format: 'jpeg', rotate: outputRotate },
      });

      // Aceita tanto retorno string quanto objeto { uri }
      const out = result as unknown as CropResult;
      const nextFileUri = ensureFileUri(out?.uri);

      console.log('[PREVIEW] cropDocument result:', {
        uri: nextFileUri,
        width: out?.width,
        height: out?.height,
      });

      if (nextFileUri) {
        setCroppedUri(nextFileUri);
      } else {
        setCropError('Falha ao gerar imagem recortada.');
      }
    } catch (e) {
      console.log('[PREVIEW] cropDocument error:', e);
      setCropError('Erro ao recortar a imagem.');
    } finally {
      setIsCropping(false);
    }
  }, [imageMeta, isCropping, originalUri, quadOnImage, rawPhotoMeta]);

  const handleSaveCorners = useCallback(() => {
    if (!editQuadView || !editorDisplayRect || !imageMeta) return;

    const rawQuadOnImage = quadViewToImage(editQuadView, editorDisplayRect)
      .map(p => ({
        x: clamp(p.x, 0, imageMeta.width),
        y: clamp(p.y, 0, imageMeta.height),
      })) as QuadPoints;

    const ordered = orderQuadTLTRBRBL(rawQuadOnImage);
    console.log('[PREVIEW] save corners imageMeta=', imageMeta, 'ordered=', ordered);

    setQuadOnImage(ordered);
    setIsEditing(false);
  }, [editorDisplayRect, editQuadView, imageMeta]);

  if (!originalUri) {
    return <View style={styles.empty} />;
  }

  return (
    <View style={styles.container} onLayout={onPreviewLayout}>
      <Image source={{ uri: croppedUri ?? originalUri }} style={styles.image} resizeMode='contain' />

      {previewQuadView ? (
        <View style={StyleSheet.absoluteFill} pointerEvents='none'>
          <QuadOverlay points={previewQuadView} />
        </View>
      ) : null}

      <View style={styles.bottomBar} pointerEvents='box-none'>
        <View style={styles.bottomBarRow}>
          <Pressable style={styles.btn} onPress={openEditor} disabled={!previewDisplayRect || !quadOnImage}>
            <Text style={styles.btnText}>Editar quinas</Text>
          </Pressable>

          <Pressable style={[styles.btn, isCropping && styles.btnDisabled]} onPress={handleConfirm} disabled={isCropping || !quadOnImage || !originalUri}>
            <Text style={styles.btnText}>{isCropping ? 'Recortando…' : 'Recortar'}</Text>
          </Pressable>
        </View>
        {cropError ? <Text style={styles.errorText}>{cropError}</Text> : null}
      </View>

      <Modal visible={isEditing} transparent animationType='fade' onRequestClose={() => setIsEditing(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} onLayout={onEditorLayout}>
            {/* Editor usa a foto ORIGINAL e as coordenadas */}
            <Image source={{ uri: originalUri }} style={styles.image} resizeMode='contain' />

            {imageMeta && editorDisplayRect && editQuadView ? (
              <View style={StyleSheet.absoluteFill} pointerEvents='box-none'>
                <QuadOverlay points={editQuadView} />

                <CornerHandle index={0} point={editQuadView[0]} onMove={updateEditPoint} />
                <CornerHandle index={1} point={editQuadView[1]} onMove={updateEditPoint} />
                <CornerHandle index={2} point={editQuadView[2]} onMove={updateEditPoint} />
                <CornerHandle index={3} point={editQuadView[3]} onMove={updateEditPoint} />

                <View style={styles.modalBottomBar} pointerEvents='box-none'>
                  <View style={styles.bottomBarRow}>
                    <Pressable style={styles.btnSecondary} onPress={() => setIsEditing(false)}>
                      <Text style={styles.btnText}>Cancelar</Text>
                    </Pressable>
                    <Pressable style={styles.btn} onPress={handleSaveCorners}>
                      <Text style={styles.btnText}>Salvar</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

type QuadOverlayProps = {
  points: QuadPoints;
};

function QuadOverlay({ points }: QuadOverlayProps): React.ReactElement {
  // Polyline não fecha automaticamente, então adicionamos o primeiro ponto no final
  const pts = [...points, points[0]].map(p => `${p.x},${p.y}`).join(' ');

  return (
    <Svg style={StyleSheet.absoluteFill}>
      <Polygon points={pts} fill='rgba(24, 31, 219, 0.18)' />
      <Polyline points={pts} fill='none' stroke='rgba(24, 31, 219, 0.95)' strokeWidth={3} />
    </Svg>
  );
}

type CornerHandleProps = {
  index: 0 | 1 | 2 | 3;
  point: Point;
  onMove: (index: 0 | 1 | 2 | 3, next: Point) => void;
};

function CornerHandle({ index, point, onMove }: CornerHandleProps): React.ReactElement {
  const startRef = useRef<Point>({ x: point.x, y: point.y });

  useEffect(() => {
    startRef.current = { x: point.x, y: point.y };
  }, [point.x, point.y]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          startRef.current = { x: point.x, y: point.y };
        },
        onPanResponderMove: (_evt, gesture) => {
          onMove(index, {
            x: startRef.current.x + gesture.dx,
            y: startRef.current.y + gesture.dy,
          });
        },
      }),
    [index, onMove, point.x, point.y],
  );

  return (
    <View
      style={[
        styles.handle,
        {
          left: point.x - HANDLE_SIZE / 2,
          top: point.y - HANDLE_SIZE / 2,
        },
      ]}
      {...panResponder.panHandlers}
    />
  );
}

const HANDLE_SIZE = 22;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  image: { width: '100%', height: '100%' },
  empty: { flex: 1, backgroundColor: '#000' },

  handle: {
    position: 'absolute',
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    borderRadius: HANDLE_SIZE / 2,
    backgroundColor: '#1036ceff',
    borderWidth: 2,
    borderColor: '#111',
  },

  bottomBar: { position: 'absolute', left: 0, right: 0, bottom: 24, alignItems: 'center' },
  bottomBarRow: { flexDirection: 'row', gap: 12 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    padding: 16,
    justifyContent: 'center',
  },
  modalCard: {
    width: '100%',
    aspectRatio: 3 / 4,
    backgroundColor: '#000',
    borderRadius: 14,
    overflow: 'hidden',
  },
  modalBottomBar: { position: 'absolute', left: 0, right: 0, bottom: 12, alignItems: 'center' },

  btn: { paddingVertical: 12, paddingHorizontal: 18, borderRadius: 12, backgroundColor: '#111' },
  btnSecondary: {
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 12,
    backgroundColor: '#222',
  },
  btnText: { color: '#fff', fontWeight: '700' },
  btnDisabled: { opacity: 0.6 },
  statusText: { marginTop: 10, color: '#fff', opacity: 0.85, fontWeight: '600' },
  errorText: { marginTop: 10, color: '#ff4d4f', fontWeight: '700' },
});

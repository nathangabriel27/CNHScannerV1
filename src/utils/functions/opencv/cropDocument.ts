import RNFS from 'react-native-fs';
import { DataTypes, DecompTypes, ObjectType, OpenCV } from 'react-native-fast-opencv';

export type Point = { x: number; y: number };
export type Quad = readonly [Point, Point, Point, Point];

export type CropDocumentInput = {
  /** Aceita "file:///..." ou path normal */
  fileUri: string;
  /** 4 pontos em px, no espaço da FOTO (photoSize) */
  quad: Quad;
  /** Se true, adiciona logs detalhados do fluxo de crop */
  debug?: boolean;
  output?: {
    /** default: 'jpeg' */
    format?: 'jpeg' | 'png';
    /**
     * Rotaciona o resultado FINAL antes de salvar/retornar.
     * Útil para casos onde a foto original depende de EXIF orientation (VisionCamera),
     * mas o OpenCV trabalha com pixels “crus”.
     *
     * - 'cw'  : 90° horário
     * - 'ccw' : 90° anti-horário
     * - '180' : 180°
     * - 'none': sem rotação (default)
     */
    rotate?: 'none' | 'cw' | 'ccw' | '180';
    /** default: false. Se true, retorna também o base64 puro (sem data:). */
    returnBase64?: boolean;
    /**
     * Se informado, grava a imagem recortada nesse caminho (pode ser "file:///..." ou path normal)
     * e retorna `uri` no resultado.
     */
    outputFileUri?: string;
  };
};

export type CropDocumentResult = {
  /** uri do arquivo salvo quando outputFileUri foi informado */
  uri?: string;
  /** base64 puro (sem data:) quando returnBase64=true */
  base64?: string;
  width: number;
  height: number;
};

type OcvInvokeResult<T> = { value: T } | T;

// Tipagem “segura” para nomes dinâmicos do OpenCV.invoke
const ocvInvoke = OpenCV.invoke as unknown as <T = unknown>(name: string, ...args: readonly unknown[]) => OcvInvokeResult<T>;

// Wrappers dinâmicos (evitam briga com overloads específicos do createObject/addObjectToVector)
const ocvCreateObject = OpenCV.createObject as unknown as (type: ObjectType, ...args: readonly unknown[]) => unknown;

const normalizePath = (fileUri: string): string => {
  if (fileUri.startsWith('file://')) return fileUri.replace('file://', '');
  return fileUri;
};

const toFileUri = (path: string): string => (path.startsWith('file://') ? path : `file://${path}`);

const makeTempOutputPath = (format: 'jpeg' | 'png'): string => {
  const ext = format === 'png' ? 'png' : 'jpg';
  const rand = Math.random().toString(16).slice(2);
  return `${RNFS.CachesDirectoryPath}/cnh_crop_${Date.now()}_${rand}.${ext}`;
};

const isFiniteNumber = (n: number): boolean => Number.isFinite(n) && !Number.isNaN(n);

const assertValidQuad = (quad: Quad): void => {
  for (const p of quad) {
    if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) {
      throw new Error('[cropDocumentFromFile] quad inválido: coordenadas precisam ser números finitos.');
    }
  }
};

const dist = (a: Point, b: Point): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
};

/**
 * Ordena os 4 pontos como: [topLeft, topRight, bottomRight, bottomLeft]
 * Usando soma/diferença (determinístico e costuma evitar pontos “virados”).
 */
const orderQuad = (quad: Quad): Quad => {
  const pts = [...quad];

  const sum = (p: Point) => p.x + p.y;
  const diff = (p: Point) => p.y - p.x;

  // TL = menor soma, BR = maior soma
  let tl = pts[0];
  let br = pts[0];
  for (const p of pts) {
    if (sum(p) < sum(tl)) tl = p;
    if (sum(p) > sum(br)) br = p;
  }

  // TR = menor (y-x), BL = maior (y-x)
  let tr = pts[0];
  let bl = pts[0];
  for (const p of pts) {
    if (diff(p) < diff(tr)) tr = p;
    if (diff(p) > diff(bl)) bl = p;
  }

  return [tl, tr, br, bl] as const;
};

const addPointsToVector = (points: readonly Point[], debug?: boolean, label?: string) => {
  // IMPORTANTE:
  // No iOS, o react-native-fast-opencv espera que os argumentos de getPerspectiveTransform
  // sejam realmente um `Point2fVector` construído *já contendo* os `Point2f`.
  // Criar vazio + addObjectToVector pode gerar um vetor incompatível e dispara:
  //   (-215) src.checkVector(2, CV_32F) == 4 && dst.checkVector(2, CV_32F) == 4

  if (points.length !== 4) {
    throw new Error(`[cropDocumentFromFile] Esperado 4 pontos, recebido ${points.length}.`);
  }

  const pointObjects = points.map(p => ocvCreateObject(ObjectType.Point2f, p.x, p.y));

  // Observação: `createObject(ObjectType.Point2fVector, <array>)`
  // é o formato que o native espera.
  const vec = ocvCreateObject(ObjectType.Point2fVector, pointObjects);

  if (debug) {
    const first = points[0];
    const last = points[points.length - 1];

    console.log('[cropDocumentFromFile] vector built', {
      label,
      type: 'Point2fVector',
      count: points.length,
      first: first ? { x: Number(first.x.toFixed(3)), y: Number(first.y.toFixed(3)) } : undefined,
      last: last ? { x: Number(last.x.toFixed(3)), y: Number(last.y.toFixed(3)) } : undefined,
    });
  }

  return vec;
};

const unwrapValue = <T,>(v: OcvInvokeResult<T>): T => {
  if (typeof v === 'object' && v !== null && 'value' in v) return (v as { value: T }).value;
  return v as T;
};

/**
 * Recorta o documento aplicando correção de perspectiva (warpPerspective).
 * - `quad` deve estar no espaço da FOTO (photo px).
 * - Pode retornar `base64` (opcional) e/ou salvar em arquivo (opcional).
 */
export const cropDocumentFromFile = async (input: CropDocumentInput): Promise<CropDocumentResult> => {
  const { fileUri, quad, output, debug } = input;
  if (debug) {
    console.log('[cropDocumentFromFile] start', {
      fileUri,
      quadLen: quad.length,
      format: output?.format ?? 'jpeg',
      returnBase64: Boolean(output?.returnBase64),
      hasOutputFileUri: Boolean(output?.outputFileUri),
      rotate: output?.rotate ?? 'none',
    });
  }

  assertValidQuad(quad);

  const format = output?.format ?? 'jpeg';
  const returnBase64 = output?.returnBase64 ?? false;
  const outputFileUri = output?.outputFileUri;
  const rotate = output?.rotate ?? 'none';

  // Se o caller não pediu base64 e também não informou outputFileUri,
  // salvamos por padrão em um arquivo temporário no cache e retornamos `uri`.
  // Isso deixa o helper reutilizável em qualquer tela (ex: Preview).
  const outFormat: 'jpeg' | 'png' = format === 'png' ? 'png' : 'jpeg';
  const shouldWriteFile = Boolean(outputFileUri) || !returnBase64;
  const effectiveOutputFileUri = outputFileUri ?? (shouldWriteFile ? toFileUri(makeTempOutputPath(outFormat)) : undefined);

  const path = normalizePath(fileUri);
  const base64 = await RNFS.readFile(path, 'base64');

  if (debug) {
    console.log('[cropDocumentFromFile] file read', {
      path,
      base64Len: base64.length,
    });
  }

  try {
    const src = OpenCV.base64ToMat(base64);

    if (debug) {
      console.log('[cropDocumentFromFile] S1 mat created');
    }

    const q = orderQuad(quad);
    const [tl, tr, br, bl] = q;

    // tamanho do documento final (estimado pelas arestas)
    const width = Math.max(dist(tl, tr), dist(bl, br));
    const height = Math.max(dist(tl, bl), dist(tr, br));

    const outW = Math.max(1, Math.round(width));
    const outH = Math.max(1, Math.round(height));

    if (debug) console.log('[cropDocumentFromFile] S2 ordered + outputSize', { outW, outH });

    // src points -> dst points
    const srcPts = addPointsToVector([tl, tr, br, bl], debug, 'srcPts');
    const dstPts = addPointsToVector(
      [
        { x: 0, y: 0 },
        { x: outW - 1, y: 0 },
        { x: outW - 1, y: outH - 1 },
        { x: 0, y: outH - 1 },
      ],
      debug,
      'dstPts',
    );

    // getPerspectiveTransform em RN Fast OpenCV exige também `solveMethod`.
    // Sem isso, o native tenta acessar um argumento que não existe e estoura:
    // "Argument index (3) is out of bounds!"
    const solveMethod = DecompTypes.DECOMP_LU;

    if (debug) {
      console.log('[cropDocumentFromFile] S3 getPerspectiveTransform call', { solveMethod });
    }

    const MRes = ocvInvoke('getPerspectiveTransform', srcPts, dstPts, solveMethod);
    const M = unwrapValue(MRes);

    if (debug) console.log('[cropDocumentFromFile] S4 perspective matrix ok');

    const dsize = OpenCV.createObject(ObjectType.Size, outW, outH);

    // Cria dst com o mesmo "type" do src quando possível.
    // Em alguns builds o invoke('type') pode retornar objeto (ex: { value: ... }) ou estrutura interna.
    // Se não for um número, fazemos fallback para um tipo compatível.
    const fallbackType: number =
      (DataTypes as any).CV_8UC4 ?? (DataTypes as any).CV_8UC3 ?? (DataTypes as any).CV_8U;

    let dstType: number = fallbackType;

    try {
      const tRes = ocvInvoke('type', src);
      const t = unwrapValue(tRes);

      if (typeof t === 'number' && Number.isFinite(t)) {
        dstType = t;
      } else if (debug) {
        console.log('[cropDocumentFromFile] S4.1 src type is not a number', {
          typeof: typeof t,
          value: t,
          fallbackType,
        });
      }
    } catch (e) {
      if (debug) {
        console.log('[cropDocumentFromFile] S4.1 type(src) failed, using fallback', {
          fallbackType,
          error: String(e),
        });
      }
    }

    if (debug) console.log('[cropDocumentFromFile] S4.2 create dst mat', { dstType, outW, outH });

    const dst = OpenCV.createObject(ObjectType.Mat, outH, outW, dstType);

    if (debug) console.log('[cropDocumentFromFile] S4.3 dsize + matrix ready');

    // IMPORTANTE:
    // No iOS, o binding do react-native-fast-opencv para `warpPerspective` costuma esperar
    // flags e borderMode (e em alguns casos também borderValue). Se chamarmos só com 4 args,
    // o native tenta ler argumentos que não existem e estoura:
    //   "Argument index (5) is out of bounds!"
    // Então passamos explicitamente defaults equivalentes aos do OpenCV:
    //   flags = INTER_LINEAR (1)
    //   borderMode = BORDER_CONSTANT (0)
    //   borderValue = Scalar(0,0,0,0)
    const flags = 1;
    const borderMode = 0;
    const borderValue = ocvCreateObject(ObjectType.Scalar, 0, 0, 0, 0);

    if (debug) {
      console.log('[cropDocumentFromFile] S5 warpPerspective call', {
        outW,
        outH,
        flags,
        borderMode,
        borderValueType: 'Scalar',
      });
    }

    ocvInvoke('warpPerspective', src, dst, M, dsize, flags, borderMode, borderValue);

    if (debug) console.log('[cropDocumentFromFile] S6 warpPerspective ok');

    let finalMat: unknown = dst;
    let finalW = outW;
    let finalH = outH;

    if (rotate !== 'none') {
      // OpenCV RotateFlags:
      // 0 = ROTATE_90_CLOCKWISE
      // 1 = ROTATE_180
      // 2 = ROTATE_90_COUNTERCLOCKWISE
      const rotateCode = rotate === 'cw' ? 0 : rotate === '180' ? 1 : 2;

      if (debug) console.log('[cropDocumentFromFile] S6.1 rotate start', { rotate, rotateCode });

      const rotated = OpenCV.createObject(ObjectType.Mat, 0, 0, dstType);
      ocvInvoke('rotate', dst, rotated, rotateCode);

      finalMat = rotated;

      // 90° troca dimensões
      if (rotate === 'cw' || rotate === 'ccw') {
        finalW = outH;
        finalH = outW;
      }

      if (debug) console.log('[cropDocumentFromFile] S6.2 rotate ok', { finalW, finalH });
    }

    // Precisamos do base64 quando vamos salvar em arquivo e/ou quando o caller pediu retorno em base64.
    const needsBase64 = returnBase64 || Boolean(effectiveOutputFileUri);

    let outBase64: string | undefined;
    if (needsBase64) {
      const out = OpenCV.toJSValue(finalMat as any, outFormat) as { base64: string };
      outBase64 = out.base64;
    }

    let uri: string | undefined;
    if (effectiveOutputFileUri && outBase64) {
      let outPath = normalizePath(effectiveOutputFileUri);

      // Ajusta extensão do arquivo para bater com o formato escolhido
      const desiredExt = outFormat === 'png' ? '.png' : '.jpg';
      const hasExt = /\.[a-z0-9]+$/i.test(outPath);

      if (!hasExt) {
        outPath = `${outPath}${desiredExt}`;
      } else if (!outPath.toLowerCase().endsWith(desiredExt)) {
        // se veio com extensão diferente, troca pelo formato atual
        outPath = outPath.replace(/\.[a-z0-9]+$/i, desiredExt);
      }

      if (debug) console.log('[cropDocumentFromFile] S7 output path', { outPath, outFormat });

      await RNFS.writeFile(outPath, outBase64, 'base64');
      uri = toFileUri(outPath);
      if (debug) console.log('[cropDocumentFromFile] S9 writeFile ok', { uri });
    }

    return {
      uri,
      base64: returnBase64 ? outBase64 : undefined,
      width: finalW,
      height: finalH,
    };
  } finally {
    OpenCV.clearBuffers();
  }
};